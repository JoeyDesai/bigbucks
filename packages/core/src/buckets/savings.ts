/**
 * Savings buckets (ADR "Buckets: savings buckets"): the DB side of the walk in `math.ts`. Contributions
 * are the month's `month_assignments` (so adding money is an ordinary, undoable assign), spending comes
 * from `spentByCategoryMonth`. Two queries regardless of how long the bucket has been saving.
 */
import { sql } from "drizzle-orm";
import { monthOf, today as localToday, type Milli, type Month } from "@homebase/shared";
import type { DbLike } from "../context";
import { savingsMonth, type SavingsMonth } from "./math";
import { spentByCategoryMonth, toDay } from "./spending";

export interface SavingsBucketSettings {
  id: string;
  /** First month that counts (`rollover_from`). */
  from: Month;
  /** Starting balance (`rollover_opening_milli`). */
  opening: Milli;
  /** Optional target total (`savings_target_milli`). */
  target: Milli | null;
}

/** Every savings bucket (not deleted). A missing start month counts as the current month. */
export async function savingsSettings(db: DbLike, ids?: readonly string[]): Promise<Map<string, SavingsBucketSettings>> {
  if (ids && ids.length === 0) return new Map();
  const only = ids ? sql`AND id IN ${[...ids]}` : sql``;
  const res = await db.execute<{ id: string; rollover_from: string | Date | null; rollover_opening_milli: bigint; savings_target_milli: bigint | null }>(sql`
    SELECT id, rollover_from, rollover_opening_milli, savings_target_milli FROM categories
    WHERE bucket_kind = 'savings' AND deleted_at IS NULL ${only}`);
  const now = monthOf(localToday());
  return new Map(
    res.rows.map((r) => [
      r.id,
      {
        id: r.id,
        from: r.rollover_from === null ? now : toDay(r.rollover_from),
        opening: BigInt(r.rollover_opening_milli),
        target: r.savings_target_milli === null ? null : BigInt(r.savings_target_milli),
      },
    ]),
  );
}

export type SavingsMonthRow = SavingsMonth & { started: boolean };

/** Assigned per category per month over [from, to] for `ids`. */
async function assignedByMonth(db: DbLike, from: Month, to: Month, ids: readonly string[]): Promise<Map<string, Map<Month, Milli>>> {
  const out = new Map<string, Map<Month, Milli>>();
  if (!ids.length || to < from) return out;
  const res = await db.execute<{ category_id: string; month: string | Date; assigned_milli: bigint }>(sql`
    SELECT category_id, month, assigned_milli FROM month_assignments
    WHERE category_id IN ${[...ids]} AND month >= ${from}::date AND month <= ${to}::date`);
  for (const r of res.rows) {
    let m = out.get(r.category_id);
    if (!m) out.set(r.category_id, (m = new Map()));
    m.set(toDay(r.month), BigInt(r.assigned_milli));
  }
  return out;
}

/** carryIn / contributed / spent / balance for `month`, per savings bucket. */
export async function savingsMonths(db: DbLike, month: Month, settings?: Map<string, SavingsBucketSettings>): Promise<Map<string, SavingsMonthRow>> {
  const all = settings ?? (await savingsSettings(db));
  const out = new Map<string, SavingsMonthRow>();
  const started = [...all.values()].filter((s) => s.from <= month);
  const ids = started.map((s) => s.id);
  const earliest = started.reduce<Month>((a, s) => (s.from < a ? s.from : a), month);
  const [assigned, spent] = ids.length ? await Promise.all([assignedByMonth(db, earliest, month, ids), spentByCategoryMonth(db, earliest, month, ids)]) : [new Map(), new Map()];
  for (const s of all.values()) {
    const a = assigned.get(s.id);
    const sp = spent.get(s.id);
    out.set(
      s.id,
      savingsMonth(s, month, (m) => a?.get(m) ?? 0n, (m) => sp?.get(m) ?? 0n),
    );
  }
  return out;
}

export interface SavingsContribution {
  operationId: string;
  at: Date;
  /** Added (positive) or taken out (negative). */
  amount: Milli;
  userName: string | null;
}

/**
 * The adds and take-outs this month, newest first: every budget operation (assign, move, auto-assign,
 * Add to savings) that changed this bucket's assignment for `month` and isn't undone. Seeded or imported
 * assignments have no operation; the sheet shows the difference as "Added earlier".
 */
export async function savingsContributions(db: DbLike, categoryId: string, month: Month): Promise<SavingsContribution[]> {
  const res = await db.execute<{ id: string; at: Date | string; display_name: string | null; amount: string }>(sql`
    SELECT o.id, o.at, u.display_name, sum((c->>'to')::bigint - (c->>'from')::bigint)::text AS amount
    FROM budget_operations o
    LEFT JOIN users u ON u.id = o.user_id
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(o.payload->'changes', '[]'::jsonb)) c
    WHERE o.undone_at IS NULL AND c->>'categoryId' = ${categoryId} AND c->>'month' = ${month}
    GROUP BY o.id, o.at, u.display_name
    ORDER BY o.at DESC, o.id DESC
    LIMIT 200`);
  return res.rows
    .map((r) => ({ operationId: r.id, at: r.at instanceof Date ? r.at : new Date(r.at), amount: BigInt(r.amount), userName: r.display_name }))
    .filter((r) => r.amount !== 0n);
}
