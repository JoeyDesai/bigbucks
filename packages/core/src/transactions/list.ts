/**
 * Transaction reads (spec §12.2 register, §11.3 `query_transactions`): filters, cursor pagination,
 * per-account running balance, totals.
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { CLEARED, INVESTMENT_KINDS, type Catz, type Cleared, type Flag, type ISODate, type Milli } from "@homebase/shared";
import type { DbLike } from "../context";
import { NotFoundError, ValidationError } from "../errors";
import { toDate, toDateOrNull } from "../json";

export const TransactionFiltersSchema = z.object({
  accountIds: z.array(z.string().uuid()).optional(),
  categoryIds: z.array(z.string().uuid()).optional(),
  payeeIds: z.array(z.string().uuid()).optional(),
  /** Matches payee name, memo and bank description (case-insensitive). */
  text: z.string().trim().min(1).max(200).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Signed amount bounds (milli; outflows are negative). */
  minAmount: z.bigint().optional(),
  maxAmount: z.bigint().optional(),
  /** Bounds on |amount|. */
  minAbsAmount: z.bigint().optional(),
  maxAbsAmount: z.bigint().optional(),
  approved: z.boolean().optional(),
  cleared: z.array(z.enum(CLEARED)).optional(),
  flagged: z.boolean().optional(),
  /** On-budget, non-transfer, no category (or the Uncategorized system category). */
  uncategorized: z.boolean().optional(),
  /** Only transfers (true) or no transfers (false). */
  transfers: z.boolean().optional(),
  onBudget: z.boolean().optional(),
  /** Leave out brokerage / retirement / HSA / crypto accounts (the Transactions screen). */
  excludeInvestments: z.boolean().optional(),
  entityId: z.string().uuid().optional(),
  includeDeleted: z.boolean().optional(),
});
export type TransactionFilters = z.input<typeof TransactionFiltersSchema>;

export interface SplitRow {
  id: string;
  amount: Milli;
  categoryId: string | null;
  categoryName: string | null;
  payeeId: string | null;
  memo: string | null;
  transferAccountId: string | null;
  sort: number;
}

export interface TransactionRow {
  id: string;
  date: ISODate;
  accountId: string;
  accountName: string;
  accountOnBudget: boolean;
  payeeId: string | null;
  payeeName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  memo: string | null;
  rawDescription: string | null;
  amount: Milli;
  cleared: Cleared;
  approved: boolean;
  flag: Flag | null;
  isSplit: boolean;
  splits: SplitRow[];
  transferAccountId: string | null;
  transferAccountName: string | null;
  transferPairId: string | null;
  isStartingBalance: boolean;
  source: string;
  catz: Catz | null;
  scheduledTransactionId: string | null;
  deletedAt: Date | null;
  /** Account balance after this row, in register order (null when no account filter, or pending). */
  runningBalance: Milli | null;
}

export interface TransactionPage {
  rows: TransactionRow[];
  nextCursor: string | null;
  totals: { count: number; inflow: Milli; outflow: Milli; net: Milli } | null;
}

export interface ListOptions {
  cursor?: string | null;
  /** Default 50, max 500. */
  limit?: number;
  /** Compute totals over the whole filter (default true). */
  totals?: boolean;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export function filtersWhere(f: z.output<typeof TransactionFiltersSchema>): SQL {
  const c: SQL[] = [];
  if (!f.includeDeleted) c.push(sql`t.deleted_at IS NULL`);
  if (f.accountIds?.length) c.push(sql`t.account_id IN ${f.accountIds}`);
  if (f.categoryIds?.length)
    c.push(sql`(t.category_id IN ${f.categoryIds} OR EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id AND s.category_id IN ${f.categoryIds}))`);
  if (f.payeeIds?.length) c.push(sql`(t.payee_id IN ${f.payeeIds} OR EXISTS (SELECT 1 FROM transaction_splits s WHERE s.transaction_id = t.id AND s.payee_id IN ${f.payeeIds}))`);
  if (f.text) {
    const like = `%${likeEscape(f.text)}%`;
    c.push(sql`(p.name ILIKE ${like} OR t.memo ILIKE ${like} OR t.raw_description ILIKE ${like})`);
  }
  if (f.dateFrom) c.push(sql`t.date >= ${f.dateFrom}`);
  if (f.dateTo) c.push(sql`t.date <= ${f.dateTo}`);
  if (f.minAmount !== undefined) c.push(sql`t.amount_milli >= ${f.minAmount}`);
  if (f.maxAmount !== undefined) c.push(sql`t.amount_milli <= ${f.maxAmount}`);
  if (f.minAbsAmount !== undefined) c.push(sql`abs(t.amount_milli) >= ${f.minAbsAmount}`);
  if (f.maxAbsAmount !== undefined) c.push(sql`abs(t.amount_milli) <= ${f.maxAbsAmount}`);
  if (f.approved !== undefined) c.push(sql`t.approved = ${f.approved}`);
  if (f.cleared?.length) c.push(sql`t.cleared::text IN ${f.cleared}`);
  if (f.flagged !== undefined) c.push(f.flagged ? sql`t.flag IS NOT NULL` : sql`t.flag IS NULL`);
  if (f.uncategorized !== undefined) {
    const u = sql`(a.on_budget AND NOT t.is_split AND NOT t.is_starting_balance AND t.transfer_account_id IS NULL AND (t.category_id IS NULL OR c.kind = 'uncategorized'))`;
    c.push(f.uncategorized ? u : sql`NOT ${u}`);
  }
  if (f.transfers !== undefined) c.push(f.transfers ? sql`t.transfer_account_id IS NOT NULL` : sql`t.transfer_account_id IS NULL`);
  if (f.onBudget !== undefined) c.push(sql`a.on_budget = ${f.onBudget}`);
  if (f.excludeInvestments) c.push(sql`a.kind::text NOT IN ${[...INVESTMENT_KINDS]}`);
  if (f.entityId) c.push(sql`a.entity_id = ${f.entityId}`);
  return c.length ? sql.join(c, sql` AND `) : sql`TRUE`;
}

const FROM = sql`FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  LEFT JOIN payees p ON p.id = t.payee_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN accounts ta ON ta.id = t.transfer_account_id`;

function encodeCursor(date: string, id: string): string {
  return Buffer.from(JSON.stringify([date, id])).toString("base64url");
}
function decodeCursor(cursor: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string") return [v[0], v[1]];
  } catch {
    /* fallthrough */
  }
  throw new ValidationError("invalid cursor");
}

type RawRow = {
  id: string;
  date: string;
  account_id: string;
  account_name: string;
  account_on_budget: boolean;
  payee_id: string | null;
  payee_name: string | null;
  category_id: string | null;
  category_name: string | null;
  memo: string | null;
  raw_description: string | null;
  amount_milli: bigint;
  cleared: Cleared;
  approved: boolean;
  flag: Flag | null;
  is_split: boolean;
  transfer_account_id: string | null;
  transfer_account_name: string | null;
  transfer_pair_id: string | null;
  is_starting_balance: boolean;
  source: string;
  catz: Catz | null;
  scheduled_transaction_id: string | null;
  deleted_at: Date | string | null;
  running_balance: bigint | null;
};

const SELECT = sql`SELECT t.id, t.date, t.account_id, coalesce(a.nickname, a.name) AS account_name, a.on_budget AS account_on_budget,
  t.payee_id, p.name AS payee_name, t.category_id, c.name AS category_name, t.memo, t.raw_description, t.amount_milli,
  t.cleared, t.approved, t.flag, t.is_split, t.transfer_account_id, coalesce(ta.nickname, ta.name) AS transfer_account_name,
  t.transfer_pair_id, t.is_starting_balance, t.source, t.catz, t.scheduled_transaction_id, t.deleted_at`;

async function attachSplits(db: DbLike, rows: RawRow[]): Promise<Map<string, SplitRow[]>> {
  const ids = rows.filter((r) => r.is_split).map((r) => r.id);
  const out = new Map<string, SplitRow[]>();
  if (!ids.length) return out;
  const res = await db.execute<{ id: string; transaction_id: string; amount_milli: bigint; category_id: string | null; category_name: string | null; payee_id: string | null; memo: string | null; transfer_account_id: string | null; sort: number }>(sql`
    SELECT s.id, s.transaction_id, s.amount_milli, s.category_id, c.name AS category_name, s.payee_id, s.memo, s.transfer_account_id, s.sort
    FROM transaction_splits s LEFT JOIN categories c ON c.id = s.category_id
    WHERE s.transaction_id IN ${ids} ORDER BY s.sort, s.id`);
  for (const s of res.rows) {
    const arr = out.get(s.transaction_id) ?? [];
    arr.push({ id: s.id, amount: BigInt(s.amount_milli), categoryId: s.category_id, categoryName: s.category_name, payeeId: s.payee_id, memo: s.memo, transferAccountId: s.transfer_account_id, sort: s.sort });
    out.set(s.transaction_id, arr);
  }
  return out;
}

function toRow(r: RawRow, splits: Map<string, SplitRow[]>): TransactionRow {
  return {
    id: r.id,
    date: r.date,
    accountId: r.account_id,
    accountName: r.account_name,
    accountOnBudget: r.account_on_budget,
    payeeId: r.payee_id,
    payeeName: r.payee_name,
    categoryId: r.category_id,
    categoryName: r.category_name,
    memo: r.memo,
    rawDescription: r.raw_description,
    amount: BigInt(r.amount_milli),
    cleared: r.cleared,
    approved: r.approved,
    flag: r.flag,
    isSplit: r.is_split,
    splits: splits.get(r.id) ?? [],
    transferAccountId: r.transfer_account_id,
    transferAccountName: r.transfer_account_name,
    transferPairId: r.transfer_pair_id,
    isStartingBalance: r.is_starting_balance,
    source: r.source,
    catz: r.catz,
    scheduledTransactionId: r.scheduled_transaction_id,
    deletedAt: toDateOrNull(r.deleted_at),
    runningBalance: r.running_balance === null || r.running_balance === undefined ? null : BigInt(r.running_balance),
  };
}

/** Register / query: newest first, `(date, id)` cursor. */
export async function listTransactions(db: DbLike, filters: TransactionFilters = {}, opts: ListOptions = {}): Promise<TransactionPage> {
  const f = TransactionFiltersSchema.parse(filters);
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const where = filtersWhere(f);
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  const cursorCond = cursor ? sql`(t.date, t.id) < (${cursor[0]}::date, ${cursor[1]}::uuid)` : sql`TRUE`;
  // running balance per account, in register order (pending rows excluded, like the bank's ledger)
  const rb = f.accountIds?.length
    ? sql`LEFT JOIN (
        SELECT id, sum(amount_milli) OVER (PARTITION BY account_id ORDER BY date, id)::bigint AS running_balance
        FROM transactions WHERE deleted_at IS NULL AND cleared <> 'pending' AND account_id IN ${f.accountIds}
      ) rb ON rb.id = t.id`
    : sql``;
  const rbCol = f.accountIds?.length ? sql`, rb.running_balance` : sql`, NULL::bigint AS running_balance`;
  const res = await db.execute<RawRow>(sql`${SELECT}${rbCol} ${FROM} ${rb} WHERE ${where} AND ${cursorCond} ORDER BY t.date DESC, t.id DESC LIMIT ${limit + 1}`);
  const raw = res.rows.slice(0, limit);
  const splits = await attachSplits(db, raw);
  const rows = raw.map((r) => toRow(r, splits));
  const last = raw[raw.length - 1];
  const nextCursor = res.rows.length > limit && last ? encodeCursor(last.date, last.id) : null;
  let totals: TransactionPage["totals"] = null;
  if (opts.totals !== false) {
    const t = await db.execute<{ n: bigint; inflow: bigint; outflow: bigint }>(sql`
      SELECT count(*)::bigint AS n,
        coalesce(sum(t.amount_milli) FILTER (WHERE t.amount_milli > 0), 0)::bigint AS inflow,
        coalesce(sum(t.amount_milli) FILTER (WHERE t.amount_milli < 0), 0)::bigint AS outflow
      ${FROM} WHERE ${where}`);
    const r = t.rows[0]!;
    totals = { count: Number(r.n), inflow: BigInt(r.inflow), outflow: BigInt(r.outflow), net: BigInt(r.inflow) + BigInt(r.outflow) };
  }
  return { rows, nextCursor, totals };
}

export interface TransactionDetail extends TransactionRow {
  postedAt: Date | null;
  importOrder: number | null;
  externalId: string | null;
  matchedYnabId: string | null;
  events: {
    id: string;
    at: Date;
    method: string;
    suggestedCategoryId: string | null;
    finalCategoryId: string | null;
    confidence: number | null;
    accepted: boolean | null;
    userId: string | null;
  }[];
}

export async function getTransaction(db: DbLike, id: string): Promise<TransactionDetail> {
  const res = await db.execute<RawRow & { posted_at: Date | string | null; import_order: number | null; external_id: string | null; matched_ynab_id: string | null }>(
    sql`${SELECT}, NULL::bigint AS running_balance, t.posted_at, t.import_order, t.external_id, t.matched_ynab_id ${FROM} WHERE t.id = ${id}`,
  );
  const r = res.rows[0];
  if (!r) throw new NotFoundError("transaction", id);
  const splits = await attachSplits(db, [r]);
  const ev = await db.execute<{ id: string; at: Date | string; method: string; suggested_category_id: string | null; final_category_id: string | null; confidence: number | null; accepted: boolean | null; user_id: string | null }>(
    sql`SELECT id, at, method, suggested_category_id, final_category_id, confidence, accepted, user_id FROM categorization_events WHERE transaction_id = ${id} ORDER BY at, id`,
  );
  return {
    ...toRow(r, splits),
    postedAt: toDateOrNull(r.posted_at),
    importOrder: r.import_order,
    externalId: r.external_id,
    matchedYnabId: r.matched_ynab_id,
    events: ev.rows.map((e) => ({
      id: e.id,
      at: toDate(e.at),
      method: e.method,
      suggestedCategoryId: e.suggested_category_id,
      finalCategoryId: e.final_category_id,
      confidence: e.confidence,
      accepted: e.accepted,
      userId: e.user_id,
    })),
  };
}
