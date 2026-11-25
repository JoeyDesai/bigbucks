/**
 * Net worth (spec §12.3, §13 report 4, §11.3 `net_worth`). Built from `balances` snapshots, carrying each
 * account's last known balance forward — the same rule as v_balances_daily / v_net_worth_daily: an account
 * with a positive balance is an asset, a negative balance is a liability.
 */
import { asc, sql } from "drizzle-orm";
import { entities } from "@homebase/db";
import { addDays, addMonths, lastDayOfMonth, monthOf, today as localToday, type AccountKind, type ISODate, type Milli } from "@homebase/shared";
import type { DbLike } from "../context";
import { ValidationError } from "../errors";

export type NetWorthPeriod = "1M" | "3M" | "YTD" | "1Y" | "ALL" | { from: ISODate; to?: ISODate };
export type Granularity = "day" | "week" | "month";

export interface NetWorthPoint {
  date: ISODate;
  assets: Milli;
  /** Magnitude (≥ 0) of negative balances. */
  liabilities: Milli;
  netWorth: Milli;
  byKind: Record<"cash" | "credit" | "investments" | "crypto" | "property" | "loans" | "other", Milli>;
}

export interface NetWorthResult {
  from: ISODate;
  to: ISODate;
  granularity: Granularity;
  includeBusiness: boolean;
  series: NetWorthPoint[];
  headline: {
    asOf: ISODate;
    netWorth: Milli;
    assets: Milli;
    liabilities: Milli;
    /** vs the last day of the previous month. */
    lastMonthEnd: ISODate;
    changeVsLastMonth: Milli;
    /** Basis points of |last month's net worth| (null when it was 0). */
    changeBps: number | null;
  };
}

const KIND_BUCKET: Record<AccountKind, keyof NetWorthPoint["byKind"]> = {
  checking: "cash",
  savings: "cash",
  cash: "cash",
  credit_card: "credit",
  line_of_credit: "credit",
  brokerage: "investments",
  retirement: "investments",
  hsa: "investments",
  crypto: "crypto",
  property: "property",
  mortgage: "loans",
  loan: "loans",
  other: "other",
};

/** The household entity: lowest sort (seeded "Household"). Every other entity is the business. */
export async function householdEntityId(db: DbLike): Promise<string | null> {
  const [e] = await db.select({ id: entities.id }).from(entities).orderBy(asc(entities.sort), asc(entities.name)).limit(1);
  return e?.id ?? null;
}

export interface AccountBalanceAt {
  date: ISODate;
  accountId: string;
  kind: AccountKind;
  entityId: string;
  balance: Milli;
}

/** Each (non-deleted) account's balance as of each date (last snapshot ≤ date; accounts with none are skipped). */
export async function balancesAt(db: DbLike, dates: ISODate[], opts: { includeBusiness?: boolean; accountIds?: string[] } = {}): Promise<AccountBalanceAt[]> {
  if (!dates.length) return [];
  const conds = [sql`a.deleted_at IS NULL`];
  if (!opts.includeBusiness) {
    const h = await householdEntityId(db);
    if (h) conds.push(sql`a.entity_id = ${h}`);
  }
  if (opts.accountIds?.length) conds.push(sql`a.id IN ${opts.accountIds}`);
  const res = await db.execute<{ date: string; account_id: string; kind: AccountKind; entity_id: string; balance: bigint }>(sql`
    SELECT d.date::text AS date, a.id AS account_id, a.kind, a.entity_id, b.current_milli AS balance
    FROM unnest(string_to_array(${dates.join(",")}, ',')::date[]) AS d(date)
    CROSS JOIN accounts a
    JOIN LATERAL (
      SELECT current_milli FROM balances bb WHERE bb.account_id = a.id AND bb.as_of <= d.date ORDER BY bb.as_of DESC LIMIT 1
    ) b ON true
    WHERE ${sql.join(conds, sql` AND `)}`);
  return res.rows.map((r) => ({ date: r.date, accountId: r.account_id, kind: r.kind, entityId: r.entity_id, balance: BigInt(r.balance) }));
}

function point(date: ISODate, rows: AccountBalanceAt[]): NetWorthPoint {
  const p: NetWorthPoint = { date, assets: 0n, liabilities: 0n, netWorth: 0n, byKind: { cash: 0n, credit: 0n, investments: 0n, crypto: 0n, property: 0n, loans: 0n, other: 0n } };
  for (const r of rows) {
    if (r.balance >= 0n) p.assets += r.balance;
    else p.liabilities -= r.balance;
    p.byKind[KIND_BUCKET[r.kind]] += r.balance;
  }
  p.netWorth = p.assets - p.liabilities;
  return p;
}

export function sampleDates(from: ISODate, to: ISODate, g: Granularity): ISODate[] {
  if (from > to) return [];
  const out: ISODate[] = [];
  if (g === "day") {
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  }
  if (g === "week") {
    for (let d = to; d >= from; d = addDays(d, -7)) out.push(d);
    if (out[out.length - 1] !== from) out.push(from);
    return out.reverse();
  }
  out.push(from);
  for (let m = monthOf(from); m <= monthOf(to); m = addMonths(m, 1)) {
    const end = lastDayOfMonth(m);
    if (end > from && end < to) out.push(end);
  }
  if (to !== from) out.push(to);
  return out;
}

export async function netWorth(
  db: DbLike,
  opts: { period?: NetWorthPeriod; granularity?: Granularity; includeBusiness?: boolean; today?: ISODate } = {},
): Promise<NetWorthResult> {
  const today = opts.today ?? localToday();
  const period = opts.period ?? "1Y";
  let from: ISODate;
  let to: ISODate = today;
  if (typeof period === "object") {
    from = period.from;
    to = period.to ?? today;
  } else if (period === "1M") from = addDays(today, -30);
  else if (period === "3M") from = addDays(today, -91);
  else if (period === "YTD") from = `${today.slice(0, 4)}-01-01`;
  else if (period === "1Y") from = addDays(today, -365);
  else {
    const r = await db.execute<{ d: string | null }>(sql`SELECT min(as_of)::text AS d FROM balances`);
    from = r.rows[0]?.d ?? today;
  }
  if (from > to) throw new ValidationError("period starts after it ends");
  const granularity = opts.granularity ?? (typeof period === "string" ? ({ "1M": "day", "3M": "week", YTD: "week", "1Y": "month", ALL: "month" } as const)[period] : "month");
  const dates = sampleDates(from, to, granularity);
  const lastMonthEnd = lastDayOfMonth(addMonths(monthOf(today), -1));
  const all = await balancesAt(db, [...new Set([...dates, today, lastMonthEnd])], { includeBusiness: opts.includeBusiness });
  const byDate = new Map<ISODate, AccountBalanceAt[]>();
  for (const r of all) {
    const arr = byDate.get(r.date) ?? [];
    arr.push(r);
    byDate.set(r.date, arr);
  }
  const series = dates.map((d) => point(d, byDate.get(d) ?? []));
  const now = point(today, byDate.get(today) ?? []);
  const prev = point(lastMonthEnd, byDate.get(lastMonthEnd) ?? []);
  const change = now.netWorth - prev.netWorth;
  const base = prev.netWorth < 0n ? -prev.netWorth : prev.netWorth;
  return {
    from,
    to,
    granularity,
    includeBusiness: !!opts.includeBusiness,
    series,
    headline: {
      asOf: today,
      netWorth: now.netWorth,
      assets: now.assets,
      liabilities: now.liabilities,
      lastMonthEnd,
      changeVsLastMonth: change,
      changeBps: base === 0n ? null : Number((change * 10_000n) / base),
    },
  };
}
