/**
 * Read model for the Reflect tab: spending per bucket per month over a window of months, income per
 * month, and the biggest places for one month. Spending follows the Budget screen's rules
 * (`spendingLines`: on-budget, posted, no budget↔budget transfers, split lines under their own bucket).
 */
import { sql } from "drizzle-orm";
import { addMonths, lastDayOfMonth, type Milli, type Month } from "@homebase/shared";
import type { DbLike } from "../context";
import { listCategories } from "../budget/operations";
import type { BucketKind } from "./math";
import { spendingLines } from "./spending";

export interface ReflectBucket {
  id: string;
  name: string;
  icon: string | null;
  groupId: string;
  groupName: string;
  bucketKind: BucketKind;
  /** Net spending per month, aligned to `ReflectData.months` (refunds reduce it; may be negative). */
  spent: Milli[];
  /** Σ spent over the window. */
  total: Milli;
}

export interface ReflectPlace {
  name: string;
  spent: Milli;
  count: number;
}

export interface ReflectData {
  /** Oldest → newest, ending at the selected month. */
  months: Month[];
  /** Normal buckets (hidden ones included) that had any spending in the window, in plan order. */
  buckets: ReflectBucket[];
  /** Σ bucket spending per month (savings buckets included: money spent out of them is still spent). */
  spent: Milli[];
  /** Money that came in per month (lines categorized as Income). */
  income: Milli[];
  /** On-budget outflows with no bucket per month (not in `spent`). */
  uncategorized: Milli[];
  /** The selected (last) month's biggest places by spending, raw payee names. */
  places: ReflectPlace[];
}

/** `count` months ending at `to` (oldest first). */
export function reflectMonths(to: Month, count: number): Month[] {
  return Array.from({ length: count }, (_, i) => addMonths(to, i - (count - 1)));
}

export async function getReflect(db: DbLike, to: Month, opts: { months?: number; places?: number } = {}): Promise<ReflectData> {
  const months = reflectMonths(to, opts.months ?? 12);
  const from = months[0]!;
  const end = lastDayOfMonth(to);
  const idx = new Map(months.map((m, i) => [m, i] as const));
  const zeros = () => months.map(() => 0n);

  const res = await db.execute<{ category_id: string; kind: string; month: string; net: bigint }>(sql`${spendingLines(from, end)}
    SELECT l.category_id, c.kind::text AS kind, to_char(date_trunc('month', l.date), 'YYYY-MM-DD') AS month, sum(l.amount_milli)::bigint AS net
    FROM lines l JOIN categories c ON c.id = l.category_id GROUP BY 1, 2, 3`);
  const byCat = new Map<string, Milli[]>();
  const income = zeros();
  for (const r of res.rows) {
    const i = idx.get(String(r.month).slice(0, 10) as Month);
    if (i === undefined) continue;
    const net = BigInt(r.net);
    if (r.kind === "internal_rta") income[i] = income[i]! + net;
    if (r.kind !== "normal") continue;
    let a = byCat.get(r.category_id);
    if (!a) byCat.set(r.category_id, (a = zeros()));
    a[i] = a[i]! - net;
  }

  const uncategorized = zeros();
  const un = await db.execute<{ month: string; spent: bigint }>(sql`
    SELECT to_char(date_trunc('month', t.date), 'YYYY-MM-DD') AS month, coalesce(-sum(t.amount_milli) FILTER (WHERE t.amount_milli < 0), 0)::bigint AS spent
    FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN categories c ON c.id = t.category_id
    WHERE t.deleted_at IS NULL AND a.deleted_at IS NULL AND a.on_budget AND t.cleared <> 'pending' AND NOT t.is_split AND NOT t.is_starting_balance
      AND t.transfer_account_id IS NULL AND (t.category_id IS NULL OR c.kind = 'uncategorized') AND t.date >= ${from}::date AND t.date <= ${end}::date
    GROUP BY 1`);
  for (const r of un.rows) {
    const i = idx.get(String(r.month).slice(0, 10) as Month);
    if (i !== undefined) uncategorized[i] = BigInt(r.spent);
  }

  const buckets: ReflectBucket[] = [];
  for (const g of await listCategories(db, { includeHidden: true })) {
    if (g.isSystem) continue;
    for (const c of g.categories) {
      const spent = c.kind === "normal" ? byCat.get(c.id) : undefined;
      if (!spent || spent.every((v) => v === 0n)) continue;
      buckets.push({ id: c.id, name: c.name, icon: c.icon, groupId: g.id, groupName: g.name, bucketKind: c.bucketKind, spent, total: spent.reduce((a, v) => a + v, 0n) });
    }
  }
  const spent = months.map((_, i) => buckets.reduce((a, b) => a + b.spent[i]!, 0n));

  const pl = await db.execute<{ name: string; spent: bigint; n: number }>(sql`
    SELECT coalesce(p.name, t.raw_description, 'Unknown') AS name, (-sum(t.amount_milli))::bigint AS spent, count(*)::int AS n
    FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN categories c ON c.id = t.category_id LEFT JOIN payees p ON p.id = t.payee_id
    WHERE t.deleted_at IS NULL AND a.deleted_at IS NULL AND a.on_budget AND t.cleared <> 'pending' AND NOT t.is_split AND NOT t.is_starting_balance
      AND t.transfer_account_id IS NULL AND c.kind = 'normal' AND t.date >= ${to}::date AND t.date <= ${end}::date
    GROUP BY 1 HAVING -sum(t.amount_milli) > 0 ORDER BY 2 DESC LIMIT ${opts.places ?? 6}`);
  const places = pl.rows.map((r) => ({ name: r.name, spent: BigInt(r.spent), count: Number(r.n) }));

  return { months, buckets, spent, income, uncategorized, places };
}
