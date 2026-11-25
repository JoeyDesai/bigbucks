/**
 * CategorizerRepo on Postgres via @homebase/db.
 *
 * Payee keys: the categorizer's `normalizedKey()` strips every non-alphanumeric character
 * ("Lowe's" → "lowes"), while rows written by the demo seed / YNAB import may use a spaced form
 * ("lowe s"). Lookups therefore compare on the stripped form of `payees.normalized_key`; new payees
 * are written with the categorizer's key.
 */
import { and, asc, desc, eq, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import { schema as s, type Db } from "@homebase/db";
import { formatMilli, absMilli, currentMonth, newId, type CatzMethod, type ISODate, type Milli } from "@homebase/shared";
import { MerchantProfileSchema, microUsdToUsdString, usdToMicro, type MerchantProfile, type SimilarTxn } from "@homebase/ai";
import type { CategorizationEvent, CategorizationEventInput, CategorizerRepo, SimilarQuery } from "../repo";
import { parseRule, ruleToJson, type Rule } from "../rules";
import type { TransferTxn } from "../transfers";
import type { AccountInfo, CategoryInfo, HistoryTxn, PayeeAlias, PayeeRecord, TxnInput } from "../types";

/** SQL expression: payees.normalized_key reduced to [a-z0-9] (matches categorizer normalizedKey()). */
export const strippedPayeeKey = sql`regexp_replace(lower(${s.payees.normalizedKey}), '[^a-z0-9]', '', 'g')`;

function payeeKeyMatches(key: string): SQL {
  return sql`(${s.payees.normalizedKey} = ${key} OR ${strippedPayeeKey} = ${key})`;
}

/** Tolerant read of payees.merchant (older rows may miss fields). */
export function toMerchantProfile(raw: unknown): MerchantProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const parsed = MerchantProfileSchema.safeParse({
    website: r.website ?? null,
    type: r.type ?? "unknown",
    location: r.location ?? null,
    description: r.description ?? "",
    confidence: typeof r.confidence === "number" ? r.confidence : 0,
    looked_up_at: r.looked_up_at ?? "",
    found: r.found ?? true,
  });
  return parsed.success ? parsed.data : null;
}

function targetSummary(t: { type: string; amountMilli: Milli; cadence: string; cadenceEvery: number; percent: string | null; removed: boolean }): string | null {
  if (t.removed) return null;
  if (t.type === "percent_of_income") return `${t.percent ?? "?"}% of income`;
  const cadence = t.cadence === "every_n_months" ? `every ${t.cadenceEvery} months` : t.cadence === "none" ? "" : t.cadence;
  return [t.type.replace(/_/g, " "), formatMilli(t.amountMilli), cadence].filter(Boolean).join(" ");
}

export interface DbCategorizerRepoOptions {
  /** Name of the household entity (everything else counts as business). Default "Household". */
  householdEntityName?: string;
  /** Similar transactions are drawn only from approved rows (default true). */
  similarApprovedOnly?: boolean;
}

export class DbCategorizerRepo implements CategorizerRepo {
  /** Rules that failed to parse (skipped), for Settings → Rules diagnostics. */
  readonly ruleWarnings: { ruleId: string; error: string }[] = [];

  constructor(
    private readonly db: Db,
    private readonly opts: DbCategorizerRepoOptions = {},
  ) {}

  async getCategoryCatalog(): Promise<CategoryInfo[]> {
    const rows = await this.db
      .select({
        id: s.categories.id,
        name: s.categories.name,
        kind: s.categories.kind,
        hidden: s.categories.hidden,
        groupHidden: s.categoryGroups.hidden,
        note: s.categories.note,
        alwaysReview: s.categories.alwaysReview,
        group: s.categoryGroups.name,
      })
      .from(s.categories)
      .innerJoin(s.categoryGroups, eq(s.categoryGroups.id, s.categories.groupId))
      .where(and(isNull(s.categories.deletedAt), isNull(s.categoryGroups.deletedAt)))
      .orderBy(asc(s.categoryGroups.sort), asc(s.categories.sort));

    const examples = await this.db.execute<{ category_id: string; name: string }>(sql`
      SELECT category_id, name FROM (
        SELECT t.category_id, p.name, row_number() OVER (PARTITION BY t.category_id ORDER BY count(*) DESC, p.name) AS rn
        FROM ${s.transactions} t JOIN ${s.payees} p ON p.id = t.payee_id
        WHERE t.category_id IS NOT NULL AND t.deleted_at IS NULL AND p.transfer_account_id IS NULL AND p.deleted_at IS NULL
        GROUP BY t.category_id, p.name
      ) x WHERE rn <= 5`);
    const byCat = new Map<string, string[]>();
    for (const e of examples.rows) (byCat.get(e.category_id) ?? byCat.set(e.category_id, []).get(e.category_id)!).push(e.name);

    const month = currentMonth();
    const targets = await this.db.execute<{ category_id: string; type: string; amount_milli: bigint; cadence: string; cadence_every: number; percent: string | null; removed: boolean }>(sql`
      SELECT DISTINCT ON (category_id) category_id, type, amount_milli, cadence, cadence_every, percent, removed
      FROM ${s.targets} WHERE effective_from <= ${month} ORDER BY category_id, effective_from DESC`);
    const tByCat = new Map(targets.rows.map((t) => [t.category_id, targetSummary({ type: t.type, amountMilli: t.amount_milli, cadence: t.cadence, cadenceEvery: t.cadence_every, percent: t.percent, removed: t.removed })]));

    return rows.map((r) => ({
      id: r.id,
      group: r.group,
      name: r.name,
      kind: r.kind,
      hidden: r.hidden || r.groupHidden,
      note: r.note,
      target: tByCat.get(r.id) ?? null,
      examplePayees: byCat.get(r.id) ?? [],
      alwaysReview: r.alwaysReview,
    }));
  }

  async getAccounts(): Promise<AccountInfo[]> {
    const rows = await this.db
      .select({
        id: s.accounts.id,
        name: s.accounts.name,
        nickname: s.accounts.nickname,
        institution: s.accounts.institution,
        kind: s.accounts.kind,
        onBudget: s.accounts.onBudget,
        entity: s.entities.name,
        entitySort: s.entities.sort,
      })
      .from(s.accounts)
      .innerJoin(s.entities, eq(s.entities.id, s.accounts.entityId))
      .where(isNull(s.accounts.deletedAt));
    const household = this.opts.householdEntityName ?? (rows.some((r) => r.entity === "Household") ? "Household" : [...rows].sort((a, b) => a.entitySort - b.entitySort)[0]?.entity);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      nickname: r.nickname,
      institution: r.institution,
      kind: r.kind,
      onBudget: r.onBudget,
      entity: r.entity,
      isBusiness: r.entity !== household,
      llmLabel: r.nickname ?? r.name,
    }));
  }

  async getHouseholdMemory(): Promise<string[]> {
    const rows = await this.db.select({ text: s.householdMemory.text }).from(s.householdMemory).orderBy(asc(s.householdMemory.createdAt));
    return rows.map((r) => r.text);
  }

  async getAliases(): Promise<PayeeAlias[]> {
    return this.db.select({ id: s.payeeAliases.id, pattern: s.payeeAliases.pattern, match: s.payeeAliases.match, payeeId: s.payeeAliases.payeeId }).from(s.payeeAliases);
  }

  private payeeSelect() {
    return this.db
      .select({
        id: s.payees.id,
        name: s.payees.name,
        normalizedKey: s.payees.normalizedKey,
        defaultCategoryId: s.payees.defaultCategoryId,
        transferAccountId: s.payees.transferAccountId,
        merchant: s.payees.merchant,
      })
      .from(s.payees);
  }

  private toPayee(r: { id: string; name: string; normalizedKey: string; defaultCategoryId: string | null; transferAccountId: string | null; merchant: unknown }): PayeeRecord {
    return { ...r, merchant: toMerchantProfile(r.merchant) };
  }

  async getPayeeById(id: string): Promise<PayeeRecord | null> {
    const [r] = await this.payeeSelect().where(and(eq(s.payees.id, id), isNull(s.payees.deletedAt))).limit(1);
    return r ? this.toPayee(r) : null;
  }

  async getPayeeByKey(normalizedKey: string): Promise<PayeeRecord | null> {
    if (!normalizedKey) return null;
    const rows = await this.payeeSelect()
      .where(and(payeeKeyMatches(normalizedKey), isNull(s.payees.deletedAt)))
      .orderBy(sql`(${s.payees.normalizedKey} = ${normalizedKey}) DESC`, asc(s.payees.createdAt))
      .limit(1);
    return rows[0] ? this.toPayee(rows[0]) : null;
  }

  async getPayeeHistory(payeeKey: string, opts: { before?: ISODate; limit?: number } = {}): Promise<HistoryTxn[]> {
    const rows = await this.db
      .select({
        id: s.transactions.id,
        date: s.transactions.date,
        amountMilli: s.transactions.amountMilli,
        categoryId: s.transactions.categoryId,
        isSplit: s.transactions.isSplit,
        transferAccountId: s.transactions.transferAccountId,
      })
      .from(s.transactions)
      .innerJoin(s.payees, eq(s.payees.id, s.transactions.payeeId))
      .where(
        and(
          payeeKeyMatches(payeeKey),
          isNull(s.transactions.deletedAt),
          eq(s.transactions.approved, true),
          eq(s.transactions.isStartingBalance, false),
          opts.before ? lt(s.transactions.date, opts.before) : undefined,
        ),
      )
      .orderBy(desc(s.transactions.date))
      .limit(opts.limit ?? 200);
    return rows.map((r) => ({ id: r.id, date: r.date, amountMilli: r.amountMilli, categoryId: r.categoryId, isSplit: r.isSplit, isTransfer: r.transferAccountId !== null }));
  }

  /** pg_trgm `%` on payee name / raw description (GIN trigram indexes), boosted for amount within ±10%. */
  async similarTransactions(q: SimilarQuery): Promise<SimilarTxn[]> {
    const amt = absMilli(q.amountMilli);
    const lo = (amt * 9n) / 10n;
    const hi = (amt * 11n) / 10n;
    const approvedOnly = this.opts.similarApprovedOnly ?? true;
    const res = await this.db.execute<{
      payee: string;
      raw_description: string | null;
      amount_milli: bigint;
      date: string;
      category_id: string | null;
      category_name: string | null;
      is_transfer: boolean;
    }>(sql`
      SELECT p.name AS payee, t.raw_description, t.amount_milli, t.date, t.category_id, c.name AS category_name,
             (t.transfer_account_id IS NOT NULL) AS is_transfer
      FROM ${s.transactions} t
      JOIN ${s.payees} p ON p.id = t.payee_id
      LEFT JOIN ${s.categories} c ON c.id = t.category_id
      WHERE t.deleted_at IS NULL AND t.id <> ${q.transactionId} AND t.date < ${q.before} AND NOT t.is_starting_balance
        AND (${approvedOnly} = false OR t.approved)
        AND (t.category_id IS NOT NULL OR t.transfer_account_id IS NOT NULL)
        AND (p.name % ${q.payeeName} OR t.raw_description % ${q.rawDescription})
      ORDER BY greatest(similarity(p.name, ${q.payeeName}), similarity(coalesce(t.raw_description, ''), ${q.rawDescription}))
               + CASE WHEN abs(t.amount_milli) BETWEEN ${lo} AND ${hi} THEN 0.25 ELSE 0 END DESC,
               t.date DESC
      LIMIT ${q.limit}`);
    return res.rows.map((r) => ({
      payee: r.payee,
      rawDescription: r.raw_description,
      amountMilli: BigInt(r.amount_milli),
      date: r.date,
      categoryId: r.category_id,
      categoryName: r.category_name,
      isTransfer: r.is_transfer,
    }));
  }

  async getTransferCandidates(txn: TxnInput, windowDays: number): Promise<TransferTxn[]> {
    const res = await this.db.execute<{ id: string; account_id: string; date: string; amount_milli: bigint; raw_description: string | null; payee_name: string | null }>(sql`
      SELECT t.id, t.account_id, t.date, t.amount_milli, t.raw_description, p.name AS payee_name
      FROM ${s.transactions} t LEFT JOIN ${s.payees} p ON p.id = t.payee_id
      JOIN ${s.accounts} a ON a.id = t.account_id
      WHERE t.id <> ${txn.id} AND t.account_id <> ${txn.accountId} AND t.amount_milli = ${-txn.amountMilli}
        AND t.date BETWEEN (${txn.date}::date - ${windowDays}::int) AND (${txn.date}::date + ${windowDays}::int)
        AND t.deleted_at IS NULL AND a.deleted_at IS NULL AND NOT t.is_starting_balance
        AND t.transfer_pair_id IS NULL AND t.transfer_account_id IS NULL`);
    return res.rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      date: r.date,
      amountMilli: BigInt(r.amount_milli),
      rawDescription: r.raw_description ?? "",
      payeeName: r.payee_name,
    }));
  }

  async getRules(): Promise<Rule[]> {
    const rows = await this.db.select().from(s.rules).orderBy(asc(s.rules.priority));
    this.ruleWarnings.length = 0;
    const out: Rule[] = [];
    for (const r of rows) {
      try {
        out.push(
          parseRule({
            id: r.id,
            name: r.name,
            priority: r.priority,
            enabled: r.enabled,
            source: r.source,
            conditions: r.conditions,
            actions: r.actions,
            hitCount: r.hitCount,
            lastHitAt: r.lastHitAt?.toISOString() ?? null,
            createdBy: r.createdBy,
          }),
        );
      } catch (e) {
        this.ruleWarnings.push({ ruleId: r.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
  }

  async countPriorReviewed(payeeKey: string, q: { incomeOverMilli: Milli; rtaCategoryId: string | null; before: ISODate }): Promise<number> {
    const res = await this.db.execute<{ n: bigint }>(sql`
      SELECT count(*) AS n FROM ${s.transactions} t JOIN ${s.payees} ON ${s.payees.id} = t.payee_id
      WHERE ${payeeKeyMatches(payeeKey)} AND t.approved AND t.deleted_at IS NULL AND t.date < ${q.before}
        AND (t.amount_milli > ${q.incomeOverMilli} OR (${q.rtaCategoryId}::uuid IS NOT NULL AND t.category_id = ${q.rtaCategoryId}::uuid))`);
    return Number(res.rows[0]?.n ?? 0);
  }

  async saveEvent(e: CategorizationEventInput): Promise<void> {
    await this.db.insert(s.categorizationEvents).values({
      transactionId: e.transactionId,
      suggestedCategoryId: e.suggestedCategoryId,
      finalCategoryId: e.finalCategoryId,
      method: e.method,
      confidence: e.confidence,
      model: e.model,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      costUsd: microUsdToUsdString(e.costMicroUsd),
      accepted: e.accepted,
      shadow: e.shadow ?? false,
      userId: e.userId ?? null,
      at: new Date(e.at),
    });
  }

  /** Non-shadow events for transactions of this payee, newest first. */
  async recentEventsForPayee(payeeKey: string, limit: number): Promise<CategorizationEvent[]> {
    const rows = await this.db
      .select({ e: s.categorizationEvents })
      .from(s.categorizationEvents)
      .innerJoin(s.transactions, eq(s.transactions.id, s.categorizationEvents.transactionId))
      .innerJoin(s.payees, eq(s.payees.id, s.transactions.payeeId))
      .where(and(payeeKeyMatches(payeeKey), eq(s.categorizationEvents.shadow, false)))
      .orderBy(desc(s.categorizationEvents.at), desc(s.categorizationEvents.id))
      .limit(limit);
    return rows.map(({ e }) => ({
      id: e.id,
      transactionId: e.transactionId,
      payeeKey,
      suggestedCategoryId: e.suggestedCategoryId,
      finalCategoryId: e.finalCategoryId,
      method: e.method as CatzMethod,
      confidence: e.confidence ?? 0,
      model: e.model,
      inputTokens: e.inputTokens ?? 0,
      outputTokens: e.outputTokens ?? 0,
      costMicroUsd: e.costUsd ? usdToMicro(e.costUsd) : 0n,
      accepted: e.accepted,
      at: e.at.toISOString(),
      shadow: e.shadow,
      userId: e.userId,
    }));
  }

  async upsertMerchantProfile(payeeKey: string, payeeName: string, profile: MerchantProfile): Promise<void> {
    const existing = await this.getPayeeByKey(payeeKey);
    if (existing) {
      await this.db.update(s.payees).set({ merchant: profile as never }).where(eq(s.payees.id, existing.id));
      return;
    }
    await this.db
      .insert(s.payees)
      .values({ id: newId(), name: payeeName, normalizedKey: payeeKey, merchant: profile as never })
      .onConflictDoUpdate({ target: s.payees.normalizedKey, set: { merchant: profile as never } });
  }

  async recordRuleHit(ruleId: string, at: string): Promise<void> {
    await this.db
      .update(s.rules)
      .set({ hitCount: sql`${s.rules.hitCount} + 1`, lastHitAt: new Date(at) })
      .where(eq(s.rules.id, ruleId));
  }

  async createRule(rule: Omit<Rule, "id">): Promise<Rule> {
    const id = newId();
    const json = ruleToJson(rule);
    await this.db.insert(s.rules).values({
      id,
      name: rule.name ?? null,
      priority: rule.priority,
      enabled: rule.enabled,
      source: rule.source,
      conditions: json.conditions,
      actions: json.actions,
      hitCount: rule.hitCount ?? 0,
      lastHitAt: rule.lastHitAt ? new Date(rule.lastHitAt) : null,
      createdBy: rule.createdBy ?? null,
    });
    return { ...rule, id };
  }

  async setRuleEnabled(ruleId: string, enabled: boolean): Promise<void> {
    await this.db.update(s.rules).set({ enabled }).where(eq(s.rules.id, ruleId));
  }

  async unapprovedTransactionIdsForPayee(payeeKey: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: s.transactions.id })
      .from(s.transactions)
      .innerJoin(s.payees, eq(s.payees.id, s.transactions.payeeId))
      .where(and(payeeKeyMatches(payeeKey), eq(s.transactions.approved, false), isNull(s.transactions.deletedAt)))
      .orderBy(asc(s.transactions.date));
    return rows.map((r) => r.id);
  }

  /** Category ids → names (for learning toasts). */
  async categoryNames(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.select({ id: s.categories.id, name: s.categories.name }).from(s.categories).where(inArray(s.categories.id, ids));
    return new Map(rows.map((r) => [r.id, r.name]));
  }
}
