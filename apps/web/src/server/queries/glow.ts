import "server-only";
import { sql } from "drizzle-orm";
import { accountBalanceHistory, budgetAccountsBalanceHistory, getBucketMonth, getReflect, listCategories, listTransactions, type BucketMonth, type ReflectData, type TransactionFilters, type TransactionRow } from "@homebase/core";
import { INVESTMENT_KINDS, addDays, type ISODate, type Month } from "@homebase/shared";
import { normalizePayee } from "@homebase/categorizer";
import type { CategoryChoice, TxItem, TxSuggestion } from "@/lib/tx";
import { cleanLabel } from "@/lib/format";
import { getDb } from "../db";

/**
 * Display name for a payee. Names that still look like a bank descriptor (a long reference number, or
 * all caps) go through the categorizer's deterministic cleanup: "ACME PAYROLL 261020 XXXX1234"
 * → "Acme Payroll". Hand-typed names are shown as they are.
 */
export function cleanPayeeName(name: string): string {
  const raw = /\d{5,}|X{4,}\d/.test(name) || (name.length > 6 && name === name.toUpperCase() && /[A-Z]/.test(name));
  return raw ? normalizePayee(name).name || name : name;
}

const NEEDS_CATEGORY = sql`(a.on_budget AND NOT t.is_split AND NOT t.is_starting_balance AND t.transfer_account_id IS NULL AND (t.category_id IS NULL OR c.kind = 'uncategorized'))`;

/** Transactions that need a look: unapproved, or on budget with no category. */
export async function loadNeedsReviewCount(): Promise<number> {
  const r = await getDb().execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.deleted_at IS NULL AND a.deleted_at IS NULL AND a.kind::text NOT IN ${[...INVESTMENT_KINDS]} AND (NOT t.approved OR ${NEEDS_CATEGORY})`);
  return r.rows[0]?.n ?? 0;
}

/** Σ on-budget balances per day for the last `days` days (sidebar sparkline). */
export async function loadCashSpark(today: ISODate, days = 60): Promise<bigint[]> {
  const pts = await budgetAccountsBalanceHistory(getDb(), { from: addDays(today, -(days - 1)), to: today });
  return pts.map((p) => p.balanceMilli);
}

export async function loadBucketMonth(month: Month, today: ISODate): Promise<BucketMonth> {
  return getBucketMonth(getDb(), month, { today });
}

/** Category choices for pickers: visible normal categories in plan order, plus "Income" (the internal RTA category). */
export async function loadCategoryChoices(): Promise<CategoryChoice[]> {
  const groups = await listCategories(getDb(), { includeHidden: true });
  const out: CategoryChoice[] = [];
  let income: CategoryChoice | null = null;
  for (const g of groups) {
    for (const c of g.categories) {
      if (c.deletedAt) continue;
      if (c.kind === "internal_rta") income = { id: c.id, name: "Income", groupName: "Income", icon: "banknote", income: true };
      if (c.kind !== "normal" || c.hidden || g.hidden) continue;
      out.push({ id: c.id, name: c.name, groupName: g.name, icon: c.icon ?? null });
    }
  }
  return income ? [...out, income] : out;
}

function suggestionsFor(r: TransactionRow, payeeDefault: string | null, valid: Set<string>): TxSuggestion[] {
  const out: TxSuggestion[] = [];
  const push = (s: TxSuggestion) => {
    if (valid.has(s.categoryId) && !out.some((o) => o.categoryId === s.categoryId)) out.push(s);
  };
  const catz = r.catz;
  for (const s of [...(catz?.suggestions ?? [])].sort((a, b) => b.confidence - a.confidence)) push({ categoryId: s.category_id, confidence: s.confidence, source: catz!.method });
  if (!out.length && r.categoryId && catz && catz.method !== "user") push({ categoryId: r.categoryId, confidence: catz.confidence, source: catz.method });
  if (payeeDefault) push({ categoryId: payeeDefault, confidence: 0.6, source: "payee" });
  return out.slice(0, 3);
}

async function payeeDefaults(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const r = await getDb().execute<{ id: string; c: string }>(sql`SELECT id, default_category_id AS c FROM payees WHERE id IN ${ids} AND default_category_id IS NOT NULL`);
  return new Map(r.rows.map((x) => [x.id, x.c]));
}

async function uncategorizedKindIds(): Promise<Set<string>> {
  const r = await getDb().execute<{ id: string }>(sql`SELECT id FROM categories WHERE kind = 'uncategorized'`);
  return new Set(r.rows.map((x) => x.id));
}

export async function toTxItems(rows: TransactionRow[], choices: CategoryChoice[]): Promise<TxItem[]> {
  const defaults = await payeeDefaults([...new Set(rows.map((r) => r.payeeId).filter((x): x is string => !!x))]);
  const uncat = await uncategorizedKindIds();
  const valid = new Set(choices.map((c) => c.id));
  return rows.map((r) => {
    const isTransfer = !!r.transferAccountId;
    const needsCategory = r.accountOnBudget && !r.isSplit && !r.isStartingBalance && !isTransfer && (r.categoryId === null || uncat.has(r.categoryId));
    return {
      id: r.id,
      date: r.date,
      // transfers read "To Savings" / "From Checking"; the chip says it's a transfer
      payee: isTransfer && r.transferAccountName ? `${r.amount < 0n ? "To" : "From"} ${cleanLabel(r.transferAccountName)}` : cleanPayeeName(r.payeeName ?? r.rawDescription ?? "No payee"),
      payeeName: r.payeeName,
      payeeId: r.payeeId,
      rawDescription: r.rawDescription,
      memo: r.memo,
      amount: r.amount,
      accountId: r.accountId,
      accountName: cleanLabel(r.accountName),
      accountOnBudget: r.accountOnBudget,
      categoryId: needsCategory ? null : r.categoryId,
      approved: r.approved,
      cleared: r.cleared,
      isSplit: r.isSplit,
      splitCount: r.splits.length,
      splits: r.splits.map((x) => ({ id: x.id, categoryId: x.categoryId, amount: x.amount, memo: x.memo })),
      transferAccountName: r.transferAccountName ? cleanLabel(r.transferAccountName) : null,
      needsCategory,
      suggestions: needsCategory || !r.approved ? suggestionsFor(r, r.payeeId ? (defaults.get(r.payeeId) ?? null) : null, valid) : [],
      method: r.catz?.method ?? null,
    };
  });
}

export type TxMode = "review" | "all";
export interface TxQuery {
  mode: TxMode;
  accountId?: string;
  q?: string;
}

export interface TxPage {
  items: TxItem[];
  nextCursor: string | null;
  /** Needs-review total for the query (review mode) or all rows (all mode). */
  total: number;
}

/**
 * The list behind the Transactions tab and account pages. "review" = unapproved ∪ uncategorized
 * (two core queries merged newest first, up to 300 rows); "all" = the register with a cursor.
 */
export async function loadTxPage(query: TxQuery, choices: CategoryChoice[], cursor?: string | null): Promise<TxPage> {
  const db = getDb();
  // investment accounts' transactions only move the Investments totals; an account's own page still lists them
  const base: TransactionFilters = { accountIds: query.accountId ? [query.accountId] : undefined, excludeInvestments: query.accountId ? undefined : true, text: query.q?.trim() || undefined };
  if (query.mode === "review") {
    const [unapproved, uncategorized] = [await listTransactions(db, { ...base, approved: false }, { limit: 300 }), await listTransactions(db, { ...base, approved: true, uncategorized: true }, { limit: 300 })];
    const rows = [...unapproved.rows, ...uncategorized.rows].sort((a, b) => (a.date === b.date ? (a.id < b.id ? 1 : -1) : a.date < b.date ? 1 : -1));
    return { items: await toTxItems(rows, choices), nextCursor: null, total: (unapproved.totals?.count ?? 0) + (uncategorized.totals?.count ?? 0) };
  }
  const page = await listTransactions(db, base, { cursor, limit: 80, totals: !cursor });
  return { items: await toTxItems(page.rows, choices), nextCursor: page.nextCursor, total: page.totals?.count ?? 0 };
}

/** Category ids this user picked most recently (categorization events), newest first. */
export async function loadRecentChoiceIds(userId: string, limit = 5): Promise<string[]> {
  const res = await getDb().execute<{ id: string }>(sql`
    SELECT e.final_category_id AS id FROM categorization_events e JOIN categories c ON c.id = e.final_category_id
    WHERE e.user_id = ${userId} AND c.kind = 'normal' AND NOT c.hidden
    GROUP BY e.final_category_id ORDER BY max(e.at) DESC LIMIT ${limit}`);
  if (res.rows.length >= 3) return res.rows.map((r) => r.id);
  const freq = await getDb().execute<{ id: string }>(sql`
    SELECT t.category_id AS id FROM transactions t JOIN categories c ON c.id = t.category_id
    WHERE c.kind = 'normal' AND NOT c.hidden AND t.deleted_at IS NULL
    GROUP BY t.category_id ORDER BY max(t.date) DESC, count(*) DESC LIMIT ${limit}`);
  return [...new Set([...res.rows.map((r) => r.id), ...freq.rows.map((r) => r.id)])].slice(0, limit);
}

export interface HistoryPoint {
  date: string;
  balance: bigint;
}

export async function loadAccountHistory(accountId: string, today: ISODate): Promise<HistoryPoint[]> {
  const pts = await accountBalanceHistory(getDb(), accountId, { today });
  return pts.map((p) => ({ date: p.date, balance: p.balanceMilli }));
}

export interface ReflectPage extends ReflectData {
  /** This month's monthly goal per spending bucket (for the bucket chart's goal line). */
  goals: Record<string, bigint | null>;
  /** First month with any history (MonthNav's lower bound). */
  first: Month | null;
}

/** The Reflect tab: 12 months ending at `month`, payee names cleaned for display. */
export async function loadReflect(month: Month, today: ISODate): Promise<ReflectPage> {
  const db = getDb();
  const [data, bm] = await Promise.all([getReflect(db, month), getBucketMonth(db, month, { today })]);
  const goals: Record<string, bigint | null> = {};
  for (const g of bm.groups) for (const r of g.rows) goals[r.id] = r.goal?.kind === "monthly" ? r.goalAmount : null;
  return { ...data, places: data.places.map((p) => ({ ...p, name: cleanLabel(cleanPayeeName(p.name)) })), goals, first: bm.range.first };
}
