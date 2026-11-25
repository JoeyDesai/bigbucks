/**
 * Spending per bucket, straight from the ledger (shared by the Budget read model and the savings-bucket
 * writes, which can't import the read model without a cycle through budget/view → budget/operations).
 */
import { sql } from "drizzle-orm";
import { lastDayOfMonth, type ISODate, type Milli, type Month } from "@homebase/shared";
import type { DbLike } from "../context";

type SpentRow = {
  category_id: string;
  spent: bigint;
  n: number;
};

/**
 * The month's spending lines over [from, to]: on-budget accounts, posted (not pending), not deleted, no
 * budget↔budget transfers, no starting balances; split lines count under their own category.
 */
export const spendingLines = (from: Month, to: ISODate) => sql`
    WITH base AS (
      SELECT t.id, t.is_split, t.category_id, t.amount_milli, t.date FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN accounts ta ON ta.id = t.transfer_account_id
      WHERE t.deleted_at IS NULL AND a.deleted_at IS NULL AND a.on_budget AND t.cleared <> 'pending'
        AND t.date >= ${from}::date AND t.date <= ${to}::date AND NOT t.is_starting_balance
        AND NOT (t.transfer_account_id IS NOT NULL AND coalesce(ta.on_budget, false))
    ), lines AS (
      SELECT category_id, amount_milli, date FROM base WHERE NOT is_split AND category_id IS NOT NULL
      UNION ALL
      SELECT s.category_id, s.amount_milli, b.date FROM base b JOIN transaction_splits s ON s.transaction_id = b.id
      WHERE b.is_split AND s.category_id IS NOT NULL AND s.transfer_account_id IS NULL
    )`;

/** Σ −amount per category for the month (see `spendingLines`). */
export async function spentByCategory(db: DbLike, month: Month): Promise<Map<string, { spent: Milli; count: number }>> {
  const res = await db.execute<SpentRow>(sql`${spendingLines(month, lastDayOfMonth(month))}
    SELECT category_id, (-sum(amount_milli))::bigint AS spent, count(*)::int AS n FROM lines GROUP BY category_id`);
  return new Map(res.rows.map((r) => [r.category_id, { spent: BigInt(r.spent), count: Number(r.n) }]));
}

/**
 * Σ −amount per category per month over [from, to] (months, inclusive) in one query; `categoryIds`
 * narrows it. Category → month → spent. Same rules as `spentByCategory`.
 */
export async function spentByCategoryMonth(db: DbLike, from: Month, to: Month, categoryIds?: readonly string[]): Promise<Map<string, Map<Month, Milli>>> {
  const out = new Map<string, Map<Month, Milli>>();
  if (to < from || (categoryIds && categoryIds.length === 0)) return out;
  const only = categoryIds ? sql`WHERE category_id IN ${[...categoryIds]}` : sql``;
  const res = await db.execute<{ category_id: string; month: string | Date; spent: bigint }>(sql`${spendingLines(from, lastDayOfMonth(to))}
    SELECT category_id, to_char(date_trunc('month', date), 'YYYY-MM-DD') AS month, (-sum(amount_milli))::bigint AS spent
    FROM lines ${only} GROUP BY category_id, 2`);
  for (const r of res.rows) {
    let m = out.get(r.category_id);
    if (!m) out.set(r.category_id, (m = new Map()));
    m.set(toDay(r.month), BigInt(r.spent));
  }
  return out;
}

export const toDay = (v: string | Date): ISODate => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

