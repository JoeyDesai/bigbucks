/**
 * Accounts (spec §5.1, §12.2 accounts list, §12.6 new-account inbox / edit): balances (cleared,
 * uncleared, working), last sync, connection status; create and update. Creating (or switching on
 * budget) a credit card creates its Credit Card Payments category (§5.1).
 */
import { and, asc, eq, isNull, max, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, balances, categories, categoryGroups, entities, transactions, type Account } from "@homebase/db";
import { ACCOUNT_KINDS, ACCOUNT_SOURCES, ON_BUDGET_KINDS, daysBetween, monthOf, type ISODate, type Milli } from "@homebase/shared";
import { writeAudit } from "../audit";
import { beginBudgetWrite } from "../budget/cache";
import { ctxToday, withTx, type Ctx, type DbLike } from "../context";
import { ValidationError } from "../errors";
import { toDateOrNull } from "../json";
import { CREDIT_KINDS, getAccountOrThrow, resolvePayee } from "./common";

export type StatusColor = "green" | "yellow" | "red" | "gray";

export interface AccountSummary {
  id: string;
  name: string;
  nickname: string | null;
  displayName: string;
  institution: string | null;
  kind: Account["kind"];
  onBudget: boolean;
  closed: boolean;
  entityId: string;
  entityName: string;
  source: Account["source"];
  balanceSign: Account["balanceSign"];
  sort: number;
  note: string | null;
  statementDueDay: number | null;
  monthlyContribution: Milli | null;
  connectionId: string | null;
  /** From the account's transactions (pending excluded). */
  clearedBalance: Milli;
  unclearedBalance: Milli;
  workingBalance: Milli;
  pendingAmount: Milli;
  transactionCount: number;
  unapprovedCount: number;
  /** Latest `balances` snapshot (what the bank/connector reported). */
  syncedBalance: Milli | null;
  syncedAsOf: ISODate | null;
  /**
   * The balance to show: on budget → working balance (falls back to the snapshot if there are no
   * transactions); off budget (tracking) → the latest `balances` snapshot (working balance only when no
   * snapshot exists, e.g. a manual tracking account).
   */
  balance: Milli;
  lastSyncAt: Date | null;
  connectionStatus: "ok" | "needs_attention" | "error" | "disabled" | null;
  connectionError: string | null;
  statusColor: StatusColor;
}

type RawAccount = {
  id: string;
  name: string;
  nickname: string | null;
  institution: string | null;
  kind: Account["kind"];
  on_budget: boolean;
  closed: boolean;
  entity_id: string;
  entity_name: string;
  source: Account["source"];
  balance_sign: Account["balanceSign"];
  sort: number;
  note: string | null;
  statement_due_day: number | null;
  monthly_contribution_milli: bigint | null;
  connection_id: string | null;
  cleared: bigint;
  uncleared: bigint;
  pending: bigint;
  n: bigint;
  unapproved: bigint;
  synced: bigint | null;
  synced_as_of: string | null;
  synced_updated_at: Date | string | null;
  conn_status: AccountSummary["connectionStatus"];
  conn_last_success: Date | string | null;
  conn_error: string | null;
};

export async function listAccounts(db: DbLike, opts: { includeClosed?: boolean; entityId?: string; today?: ISODate; ids?: string[] } = {}): Promise<AccountSummary[]> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const conds = [sql`a.deleted_at IS NULL`];
  if (!opts.includeClosed) conds.push(sql`NOT a.closed`);
  if (opts.entityId) conds.push(sql`a.entity_id = ${opts.entityId}`);
  if (opts.ids?.length) conds.push(sql`a.id IN ${opts.ids}`);
  const res = await db.execute<RawAccount>(sql`
    SELECT a.id, a.name, a.nickname, a.institution, a.kind, a.on_budget, a.closed, a.entity_id, e.name AS entity_name, a.source,
      a.balance_sign, a.sort, a.note, a.statement_due_day, a.monthly_contribution_milli, a.connection_id,
      coalesce(tx.cleared, 0)::bigint AS cleared, coalesce(tx.uncleared, 0)::bigint AS uncleared, coalesce(tx.pending, 0)::bigint AS pending,
      coalesce(tx.n, 0)::bigint AS n, coalesce(tx.unapproved, 0)::bigint AS unapproved,
      b.current_milli AS synced, b.as_of AS synced_as_of, b.updated_at AS synced_updated_at,
      c.status AS conn_status, c.last_success_at AS conn_last_success, c.last_error AS conn_error
    FROM accounts a
    JOIN entities e ON e.id = a.entity_id
    LEFT JOIN LATERAL (
      SELECT sum(amount_milli) FILTER (WHERE cleared IN ('cleared', 'reconciled')) AS cleared,
             sum(amount_milli) FILTER (WHERE cleared = 'uncleared') AS uncleared,
             sum(amount_milli) FILTER (WHERE cleared = 'pending') AS pending,
             count(*) AS n,
             count(*) FILTER (WHERE NOT approved) AS unapproved
      FROM transactions t WHERE t.account_id = a.id AND t.deleted_at IS NULL
    ) tx ON true
    LEFT JOIN LATERAL (SELECT current_milli, as_of, updated_at FROM balances bb WHERE bb.account_id = a.id ORDER BY as_of DESC LIMIT 1) b ON true
    LEFT JOIN connections c ON c.id = a.connection_id
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY a.on_budget DESC, e.sort, a.sort, a.name`);
  return res.rows.map((r) => {
    const cleared = BigInt(r.cleared);
    const uncleared = BigInt(r.uncleared);
    const n = Number(r.n);
    const synced = r.synced === null ? null : BigInt(r.synced);
    const working = cleared + uncleared;
    const lastSyncAt = toDateOrNull(r.conn_last_success) ?? (r.source !== "manual" ? toDateOrNull(r.synced_updated_at) : null);
    let statusColor: StatusColor;
    if (r.conn_status) statusColor = r.conn_status === "ok" ? "green" : r.conn_status === "needs_attention" ? "yellow" : r.conn_status === "error" ? "red" : "gray";
    else if (r.source === "manual" || r.source === "ynab_import" || r.source === "amortization") statusColor = "gray";
    else statusColor = r.synced_as_of && daysBetween(r.synced_as_of, today) <= 2 ? "green" : "yellow";
    return {
      id: r.id,
      name: r.name,
      nickname: r.nickname,
      displayName: r.nickname ?? r.name,
      institution: r.institution,
      kind: r.kind,
      onBudget: r.on_budget,
      closed: r.closed,
      entityId: r.entity_id,
      entityName: r.entity_name,
      source: r.source,
      balanceSign: r.balance_sign,
      sort: r.sort,
      note: r.note,
      statementDueDay: r.statement_due_day,
      monthlyContribution: r.monthly_contribution_milli === null ? null : BigInt(r.monthly_contribution_milli),
      connectionId: r.connection_id,
      clearedBalance: cleared,
      unclearedBalance: uncleared,
      workingBalance: working,
      pendingAmount: BigInt(r.pending),
      transactionCount: n,
      unapprovedCount: Number(r.unapproved),
      syncedBalance: synced,
      syncedAsOf: r.synced_as_of,
      // Budget accounts: the ledger is complete, so the working balance. Tracking accounts: the ledger
      // only holds transfers (contributions, mortgage payments), so the latest snapshot is the truth.
      balance: r.on_budget ? (n > 0 || synced === null ? working : synced) : (synced ?? working),
      lastSyncAt,
      connectionStatus: r.conn_status,
      connectionError: r.conn_error,
      statusColor,
    };
  });
}

export async function getAccount(db: DbLike, id: string, opts: { today?: ISODate } = {}): Promise<AccountSummary> {
  const [a] = await listAccounts(db, { includeClosed: true, ids: [id], today: opts.today });
  if (!a) throw new ValidationError(`account ${id} not found`);
  return a;
}

export const CC_GROUP_NAME = "Credit Card Payments";

/** Make sure an on-budget credit account has its payment category P(K). Returns its id. */
export async function ensurePaymentCategory(db: DbLike, account: Pick<Account, "id" | "name">): Promise<string> {
  const [existing] = await db.select().from(categories).where(and(eq(categories.kind, "cc_payment"), eq(categories.linkedAccountId, account.id)));
  if (existing) {
    if (existing.deletedAt) await db.update(categories).set({ deletedAt: null, hidden: false }).where(eq(categories.id, existing.id));
    return existing.id;
  }
  let [group] = await db.select().from(categoryGroups).where(and(eq(categoryGroups.isSystem, true), eq(categoryGroups.name, CC_GROUP_NAME), isNull(categoryGroups.deletedAt)));
  if (!group) {
    [group] = await db.insert(categoryGroups).values({ name: CC_GROUP_NAME, sort: 0, isSystem: true }).returning();
  }
  const [m] = await db.select({ s: max(categories.sort) }).from(categories).where(eq(categories.groupId, group!.id));
  const [row] = await db
    .insert(categories)
    .values({ groupId: group!.id, name: account.name, icon: "credit-card", kind: "cc_payment", linkedAccountId: account.id, sort: (m?.s ?? -1) + 1 })
    .returning({ id: categories.id });
  return row!.id;
}

const milli = z.union([z.bigint(), z.string().regex(/^-?\d+$/).transform((s) => BigInt(s))]);

export const CreateAccountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(ACCOUNT_KINDS),
  entityId: z.string().uuid().optional(),
  /** Default: on budget for checking/savings/cash/credit_card in the Household entity. */
  onBudget: z.boolean().optional(),
  institution: z.string().max(100).nullable().optional(),
  nickname: z.string().max(100).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  balanceSign: z.enum(["normal", "inverted"]).default("normal"),
  source: z.enum(ACCOUNT_SOURCES).default("manual"),
  statementDueDay: z.number().int().min(1).max(31).nullable().optional(),
  monthlyContribution: milli.nullable().optional(),
  /** Signed (cards: negative = owed). Creates the Starting Balance transaction (§6.1). */
  startingBalance: milli.optional(),
  startingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type CreateAccountInput = z.input<typeof CreateAccountSchema>;

async function householdEntityId(db: DbLike): Promise<string> {
  const [h] = await db.select({ id: entities.id }).from(entities).orderBy(asc(entities.sort), asc(entities.name)).limit(1);
  if (!h) throw new ValidationError("no entities exist");
  return h.id;
}

export async function createAccount(ctx: Ctx, input: CreateAccountInput): Promise<Account> {
  const i = CreateAccountSchema.parse(input);
  return withTx(ctx, async (tx, c) => {
    const today = ctxToday(c);
    const w = await beginBudgetWrite(tx, today);
    const household = await householdEntityId(tx);
    const entityId = i.entityId ?? household;
    const onBudget = i.onBudget ?? (ON_BUDGET_KINDS.includes(i.kind) && entityId === household);
    const [m] = await tx.select({ s: max(accounts.sort) }).from(accounts);
    const [acct] = await tx
      .insert(accounts)
      .values({
        entityId,
        name: i.name,
        nickname: i.nickname ?? null,
        institution: i.institution ?? null,
        kind: i.kind,
        onBudget,
        source: i.source,
        balanceSign: i.balanceSign,
        note: i.note ?? null,
        statementDueDay: i.statementDueDay ?? null,
        monthlyContributionMilli: i.monthlyContribution ?? null,
        sort: (m?.s ?? -1) + 1,
      })
      .returning();
    const a = acct!;
    let paymentCategoryId: string | null = null;
    if (onBudget && CREDIT_KINDS.has(a.kind)) paymentCategoryId = await ensurePaymentCategory(tx, a);
    const startDate = i.startingDate ?? today;
    if (i.startingBalance !== undefined) {
      let categoryId: string | null = null;
      if (onBudget && !CREDIT_KINDS.has(a.kind)) {
        const [rta] = await tx.select({ id: categories.id }).from(categories).where(eq(categories.kind, "internal_rta"));
        categoryId = rta?.id ?? null;
      }
      await tx.insert(transactions).values({
        accountId: a.id,
        date: startDate,
        amountMilli: i.startingBalance,
        payeeId: await resolvePayee(tx, { payeeName: "Starting Balance" }),
        categoryId,
        isStartingBalance: true,
        cleared: "cleared",
        approved: true,
        source: "manual",
      });
      await tx
        .insert(balances)
        .values({ accountId: a.id, asOf: startDate, currentMilli: i.startingBalance, source: i.source })
        .onConflictDoUpdate({ target: [balances.accountId, balances.asOf], set: { currentMilli: i.startingBalance, updatedAt: new Date() } });
    }
    await writeAudit(tx, c, { action: "account.create", entity: "account", entityId: a.id, after: { ...a, paymentCategoryId, startingBalance: i.startingBalance } });
    await w.finish(onBudget && i.startingBalance !== undefined ? monthOf(startDate) : null);
    return a;
  });
}

export const UpdateAccountSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  nickname: z.string().max(100).nullable().optional(),
  institution: z.string().max(100).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  onBudget: z.boolean().optional(),
  entityId: z.string().uuid().optional(),
  balanceSign: z.enum(["normal", "inverted"]).optional(),
  closed: z.boolean().optional(),
  statementDueDay: z.number().int().min(1).max(31).nullable().optional(),
  monthlyContribution: milli.nullable().optional(),
  sort: z.number().int().optional(),
});
export type UpdateAccountInput = z.input<typeof UpdateAccountSchema>;

export async function updateAccount(ctx: Ctx, id: string, patch: UpdateAccountInput): Promise<Account> {
  const p = UpdateAccountSchema.parse(patch);
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    const before = await getAccountOrThrow(tx, id);
    const set: Partial<typeof accounts.$inferInsert> = {};
    if (p.name !== undefined) set.name = p.name;
    if (p.nickname !== undefined) set.nickname = p.nickname || null;
    if (p.institution !== undefined) set.institution = p.institution;
    if (p.note !== undefined) set.note = p.note;
    if (p.onBudget !== undefined) set.onBudget = p.onBudget;
    if (p.entityId !== undefined) set.entityId = p.entityId;
    if (p.balanceSign !== undefined) set.balanceSign = p.balanceSign;
    if (p.closed !== undefined) set.closed = p.closed;
    if (p.statementDueDay !== undefined) set.statementDueDay = p.statementDueDay;
    if (p.monthlyContribution !== undefined) set.monthlyContributionMilli = p.monthlyContribution;
    if (p.sort !== undefined) set.sort = p.sort;
    if (Object.keys(set).length === 0) {
      await w.finish(null);
      return before;
    }
    const [after] = await tx.update(accounts).set(set).where(eq(accounts.id, id)).returning();
    const a = after!;
    if (a.onBudget && CREDIT_KINDS.has(a.kind)) await ensurePaymentCategory(tx, a);
    if (set.name !== undefined && set.name !== before.name) {
      await tx
        .update(categories)
        .set({ name: set.name })
        .where(and(eq(categories.kind, "cc_payment"), eq(categories.linkedAccountId, id), eq(categories.name, before.name)));
    }
    await writeAudit(tx, c, { action: "account.update", entity: "account", entityId: id, before, after: a });
    let from: string | null = null;
    if (set.onBudget !== undefined && set.onBudget !== before.onBudget) {
      const res = await tx.execute<{ d: string | null }>(sql`SELECT min(date) AS d FROM transactions WHERE (account_id = ${id} OR transfer_account_id = ${id}) AND deleted_at IS NULL`);
      const d = res.rows[0]?.d;
      from = d ? monthOf(d) : null;
    }
    await w.finish(from);
    return a;
  });
}

/** Write (upsert) a balance snapshot, e.g. a manual value for an off-line account. */
export async function setBalance(ctx: Ctx, input: { accountId: string; asOf?: ISODate; balance: Milli }): Promise<void> {
  await withTx(ctx, async (tx, c) => {
    const a = await getAccountOrThrow(tx, input.accountId);
    const asOf = input.asOf ?? ctxToday(c);
    await tx
      .insert(balances)
      .values({ accountId: a.id, asOf, currentMilli: input.balance, source: "manual" })
      .onConflictDoUpdate({ target: [balances.accountId, balances.asOf], set: { currentMilli: input.balance, source: "manual", updatedAt: new Date() } });
    await writeAudit(tx, c, { action: "account.set_balance", entity: "account", entityId: a.id, after: { asOf, balance: input.balance } });
  });
}


/**
 * Remove an account's entry from every connection's new-accounts inbox (`connections.meta.inbox`,
 * worker ADR "ingest rules"). Returns the number of connections changed.
 */
export async function removeFromAccountInbox(db: DbLike, accountId: string): Promise<number> {
  const res = await db.execute(sql`
    UPDATE connections
       SET meta = jsonb_set(meta, '{inbox}', coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(meta->'inbox') e WHERE e->>'accountId' IS DISTINCT FROM ${accountId}::text), '[]'::jsonb)),
           updated_at = now()
     WHERE jsonb_typeof(meta->'inbox') = 'array'
       AND meta->'inbox' @> jsonb_build_array(jsonb_build_object('accountId', ${accountId}::text))`);
  return res.rowCount ?? 0;
}

/**
 * Accept an inbox (or any off-budget) account onto the budget: on_budget = true, entity = Household
 * (creates the card's payment category for credit accounts via `updateAccount`) and clear its inbox entry.
 */
export async function putAccountOnBudget(ctx: Ctx, accountId: string): Promise<Account> {
  return withTx(ctx, async (tx, c) => {
    const household = await householdEntityId(tx);
    const a = await updateAccount(c, accountId, { onBudget: true, entityId: household });
    const removed = await removeFromAccountInbox(tx, accountId);
    if (removed) await writeAudit(tx, c, { action: "account.inbox_accept", entity: "account", entityId: accountId, after: { onBudget: true, entityId: household } });
    return a;
  });
}
