/**
 * Worker entry point for `categorize.pending`: categorize transactions nobody has categorized yet
 * and write the outcome per the §9.4 approval policy.
 *
 * Live mode writes payee, category / split / transfer pair, memo, approved and catz, plus a
 * categorization_events row, in one DB transaction per transaction. The write is guarded by
 * `catz IS NULL`, so a row a user edited meanwhile is never overwritten.
 *
 * Shadow mode (YNAB parallel run, §10) writes nothing to transactions: it records the suggestion as
 * a `shadow` event whose final_category_id is the category the row already has (YNAB's), with
 * accepted = (suggestion == existing). Rule hit counters are not touched in shadow mode.
 */
import { and, asc, eq, inArray, isNull, sql, TransactionRollbackError } from "drizzle-orm";
import { schema as s, type Db, type Tx } from "@homebase/db";
import { microUsdToUsdString, type AiClient } from "@homebase/ai";
import { INVESTMENT_KINDS, newId, type Catz } from "@homebase/shared";
import { createAiCategorizer } from "../aiAdapter";
import { categorizeTransaction, eventFor, loadPipelineContext, type PipelineResult, type PipelineSettings } from "../pipeline";
import type { CategorizationEventInput, CategorizerRepo } from "../repo";
import type { TxnInput } from "../types";
import { DbCategorizerRepo, strippedPayeeKey, toMerchantProfile } from "./DbCategorizerRepo";

export interface CategorizeJobSettings {
  /** Parallel-run shadow mode: record suggestions only. */
  shadow?: boolean;
  /** Max transactions per run (default 500). */
  limit?: number;
  /** Also categorize pending (not yet posted) rows. Default false: they are usually replaced on posting. */
  includePending?: boolean;
  pipeline?: Partial<PipelineSettings>;
  /** For the web-search privacy guard. */
  householdNames?: string[];
  now?: () => Date;
}

export interface CategorizeJobRunOptions {
  limit?: number;
  /** Restrict to these transactions (still subject to the "unprocessed" filter). */
  transactionIds?: string[];
}

export interface CategorizeJobSummary {
  mode: "live" | "shadow";
  considered: number;
  /** Rows that got a category, split or transfer (live) / a suggestion was recorded (shadow). */
  categorized: number;
  approved: number;
  transfers: number;
  /** Left uncategorized with suggestions. */
  suggestionsOnly: number;
  /** Rows changed by someone else during the run (catz no longer null) and therefore left alone. */
  skipped: number;
  /** Shadow mode: suggestions that matched the existing category / rows that had one. */
  shadowAgreement: { matched: number; compared: number } | null;
  errors: { transactionId: string; error: string }[];
  aiCalls: number;
  costMicroUsd: bigint;
  ruleWarnings: { ruleId: string; error: string }[];
}

interface Row {
  id: string;
  accountId: string;
  date: string;
  amountMilli: bigint;
  rawDescription: string | null;
  memo: string | null;
  payeeId: string | null;
  payeeName: string | null;
  categoryId: string | null;
  isSplit: boolean;
}

export function eventValues(e: CategorizationEventInput): typeof s.categorizationEvents.$inferInsert {
  return {
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
  };
}

async function loadUnprocessed(db: Db, shadow: boolean, includePending: boolean, limit: number, ids?: string[]): Promise<Row[]> {
  const t = s.transactions;
  const base = [
    isNull(t.catz),
    isNull(t.deletedAt),
    isNull(t.transferAccountId),
    isNull(t.transferPairId),
    eq(t.isStartingBalance, false),
    // investment accounts aren't budgeted: their transactions never need a bucket
    sql`NOT EXISTS (SELECT 1 FROM ${s.accounts} a WHERE a.id = ${t.accountId} AND a.kind::text IN ${[...INVESTMENT_KINDS]})`,
    includePending ? undefined : sql`${t.cleared} <> 'pending'`,
    ids ? inArray(t.id, ids) : undefined,
    shadow
      ? sql`NOT EXISTS (SELECT 1 FROM ${s.categorizationEvents} e WHERE e.transaction_id = ${t.id} AND e.shadow)`
      : and(isNull(t.categoryId), eq(t.isSplit, false)),
  ];
  return db
    .select({
      id: t.id,
      accountId: t.accountId,
      date: t.date,
      amountMilli: t.amountMilli,
      rawDescription: t.rawDescription,
      memo: t.memo,
      payeeId: t.payeeId,
      payeeName: s.payees.name,
      categoryId: t.categoryId,
      isSplit: t.isSplit,
    })
    .from(t)
    .leftJoin(s.payees, eq(s.payees.id, t.payeeId))
    .where(and(...base))
    .orderBy(asc(t.date), asc(t.createdAt))
    .limit(limit);
}

/** Find a payee by key (exact or stripped), or create it; copies a cached merchant profile from `copyMerchantFromKey`. */
async function ensurePayee(tx: Tx, name: string, key: string, copyMerchantFromKey?: string): Promise<string> {
  const find = async (k: string) =>
    (
      await tx
        .select({ id: s.payees.id, merchant: s.payees.merchant })
        .from(s.payees)
        .where(and(sql`(${s.payees.normalizedKey} = ${k} OR ${strippedPayeeKey} = ${k})`, isNull(s.payees.deletedAt)))
        .limit(1)
    )[0];
  const existing = await find(key);
  if (existing) return existing.id;
  const source = copyMerchantFromKey && copyMerchantFromKey !== key ? await find(copyMerchantFromKey) : undefined;
  const merchant = source ? toMerchantProfile(source.merchant) : null;
  const [ins] = await tx
    .insert(s.payees)
    .values({ id: newId(), name, normalizedKey: key, ...(merchant ? { merchant: merchant as never } : {}) })
    .onConflictDoNothing({ target: s.payees.normalizedKey })
    .returning({ id: s.payees.id });
  if (ins) return ins.id;
  const again = await find(key);
  if (!again) throw new Error(`could not create payee ${key}`);
  return again.id;
}

/** YNAB-style "Transfer : <account>" payee for an account, if one exists. */
async function transferPayeeId(tx: Tx, accountId: string): Promise<string | null> {
  const [p] = await tx
    .select({ id: s.payees.id })
    .from(s.payees)
    .where(and(eq(s.payees.transferAccountId, accountId), isNull(s.payees.deletedAt)))
    .limit(1);
  return p?.id ?? null;
}

function shadowRepo(repo: CategorizerRepo): CategorizerRepo {
  return new Proxy(repo, {
    get(target, prop, receiver) {
      if (prop === "recordRuleHit") return async () => {};
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/**
 * Build the `categorize.pending` job. `ai` null (or over the monthly cap) means rules and history
 * only. Returns a function the worker calls on each run.
 */
export function createCategorizeJob(db: Db, ai: AiClient | null, settings: CategorizeJobSettings = {}): (opts?: CategorizeJobRunOptions) => Promise<CategorizeJobSummary> {
  const now = settings.now ?? (() => new Date());
  const shadow = settings.shadow ?? false;

  return async (opts: CategorizeJobRunOptions = {}) => {
    const repo = new DbCategorizerRepo(db);
    const pipelineRepo = shadow ? shadowRepo(repo) : repo;
    const ctx = await loadPipelineContext(repo, settings.pipeline ?? {});
    const aiCat = ai ? createAiCategorizer(ai, settings.householdNames ? { householdNames: settings.householdNames } : {}) : null;
    const rows = await loadUnprocessed(db, shadow, settings.includePending ?? false, opts.limit ?? settings.limit ?? 500, opts.transactionIds);
    const summary: CategorizeJobSummary = {
      mode: shadow ? "shadow" : "live",
      considered: rows.length,
      categorized: 0,
      approved: 0,
      transfers: 0,
      suggestionsOnly: 0,
      skipped: 0,
      shadowAgreement: shadow ? { matched: 0, compared: 0 } : null,
      errors: [],
      aiCalls: 0,
      costMicroUsd: 0n,
      ruleWarnings: repo.ruleWarnings,
    };
    const handled = new Set<string>();

    for (const row of rows) {
      if (handled.has(row.id)) continue;
      const txn: TxnInput = {
        id: row.id,
        accountId: row.accountId,
        date: row.date,
        amountMilli: row.amountMilli,
        rawDescription: row.rawDescription ?? row.payeeName ?? "",
        memo: row.memo,
        payeeId: row.payeeId,
      };
      try {
        const result = await categorizeTransaction(txn, { repo: pipelineRepo, ai: aiCat, now }, ctx, { saveEvent: false });
        summary.aiCalls += result.ai.calls;
        summary.costMicroUsd += result.ai.costMicroUsd;
        if (shadow) {
          await recordShadow(repo, row, result, now(), summary);
        } else {
          const applied = await applyLive(db, row, result, now(), handled);
          if (!applied) {
            summary.skipped++;
            continue;
          }
          if (result.transfer || result.ruleTransferAccountId) summary.transfers++;
          if (result.categoryId || result.split || result.transfer || result.ruleTransferAccountId) summary.categorized++;
          else summary.suggestionsOnly++;
          if (result.approved) summary.approved++;
        }
        handled.add(row.id);
      } catch (e) {
        summary.errors.push({ transactionId: row.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return summary;
  };
}

async function recordShadow(repo: DbCategorizerRepo, row: Row, r: PipelineResult, at: Date, summary: CategorizeJobSummary): Promise<void> {
  const predicted = r.split ? null : r.categoryId;
  const ev = eventFor(r, at);
  const existing = row.isSplit ? null : row.categoryId;
  await repo.saveEvent({ ...ev, finalCategoryId: existing, accepted: existing ? predicted === existing : null, shadow: true });
  if (predicted || r.split || r.transfer) summary.categorized++;
  else summary.suggestionsOnly++;
  if (r.approved) summary.approved++;
  if (r.transfer) summary.transfers++;
  if (existing) {
    summary.shadowAgreement!.compared++;
    if (predicted === existing) summary.shadowAgreement!.matched++;
  }
}

/** Returns false when the row was changed by someone else (catz no longer null). */
async function applyLive(db: Db, row: Row, r: PipelineResult, at: Date, handled: Set<string>): Promise<boolean> {
  return db.transaction(async (tx) => {
    const t = s.transactions;
    const counterpartAccountId = r.transfer ? (r.transfer.outflowId === row.id ? r.transfer.inflowAccountId : r.transfer.outflowAccountId) : null;
    let payeeId = (counterpartAccountId ? await transferPayeeId(tx, counterpartAccountId) : null) ?? row.payeeId ?? r.payee.payeeId;
    if (!payeeId || (!r.transfer && r.payee.aliasProposal?.autoCreate && !r.payee.payeeId)) {
      payeeId = await ensurePayee(tx, r.payee.name, r.payee.key, r.payee.originalKey);
    }
    if (r.payee.aliasProposal?.autoCreate) {
      await tx
        .insert(s.payeeAliases)
        .values({ id: newId(), pattern: r.payee.aliasProposal.pattern, match: r.payee.aliasProposal.match, payeeId })
        .onConflictDoNothing();
    }

    const set: Partial<typeof t.$inferInsert> = { payeeId, catz: r.catz, approved: r.approved };
    if (r.memo && !row.memo) set.memo = r.memo;

    if (r.transfer) {
      const m = r.transfer;
      const mineIsOutflow = m.outflowId === row.id;
      const otherId = mineIsOutflow ? m.inflowId : m.outflowId;
      const otherAccountId = mineIsOutflow ? m.inflowAccountId : m.outflowAccountId;
      const householdSideIsOther = m.kind === "business_to_household" && m.inflowId === otherId;
      set.transferAccountId = otherAccountId;
      set.transferPairId = otherId;
      const otherPayeeId = await transferPayeeId(tx, row.accountId);
      set.categoryId = m.kind === "business_to_household" && m.inflowId === row.id ? m.householdCategoryId : null;
      const otherCatz: Catz = { method: "transfer", confidence: m.confidence, explanation: m.reason, at: at.toISOString() };
      // Counterpart: claim it only if still unpaired.
      const other = await tx
        .update(t)
        .set({
          transferAccountId: row.accountId,
          transferPairId: row.id,
          ...(otherPayeeId ? { payeeId: otherPayeeId } : {}),
          categoryId: householdSideIsOther ? m.householdCategoryId : null,
          // The household Ready-to-Assign side is left for review (§9.4 first-3 rule, conservatively).
          approved: !householdSideIsOther,
          catz: otherCatz,
        })
        .where(and(eq(t.id, otherId), isNull(t.transferPairId), isNull(t.transferAccountId), isNull(t.deletedAt)))
        .returning({ id: t.id });
      if (other.length === 0) throw new Error("transfer counterpart was already paired");
      await tx.insert(s.categorizationEvents).values(
        eventValues({
          transactionId: otherId,
          payeeKey: null,
          suggestedCategoryId: householdSideIsOther ? m.householdCategoryId : null,
          finalCategoryId: householdSideIsOther ? m.householdCategoryId : null,
          method: "transfer",
          confidence: m.confidence,
          model: null,
          inputTokens: 0,
          outputTokens: 0,
          costMicroUsd: 0n,
          accepted: householdSideIsOther ? null : true,
          at: at.toISOString(),
        }),
      );
      handled.add(otherId);
    } else if (r.ruleTransferAccountId) {
      set.transferAccountId = r.ruleTransferAccountId;
      set.categoryId = null;
    } else if (r.split) {
      await tx.delete(s.transactionSplits).where(eq(s.transactionSplits.transactionId, row.id));
      await tx.insert(s.transactionSplits).values(
        r.split.map((l, i) => ({ id: newId(), transactionId: row.id, amountMilli: l.amountMilli, categoryId: l.categoryId, memo: l.memo ?? null, sort: i })),
      );
      set.isSplit = true;
      set.categoryId = null;
    } else {
      set.categoryId = r.categoryId;
    }

    const updated = await tx
      .update(t)
      .set(set)
      .where(and(eq(t.id, row.id), isNull(t.catz), isNull(t.deletedAt)))
      .returning({ id: t.id });
    if (updated.length === 0) {
      tx.rollback();
      return false;
    }
    await tx.insert(s.categorizationEvents).values(eventValues({ ...eventFor(r, at), payeeKey: r.payee.key }));
    return true;
  }).catch((e: unknown) => {
    // drizzle signals tx.rollback() with a TransactionRollbackError
    if (e instanceof TransactionRollbackError) return false;
    throw e;
  });
}

