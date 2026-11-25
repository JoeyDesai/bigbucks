/**
 * §13 reports 1, 2 and 7: spending breakdown (YNAB Reflect), spending trends and payees.
 * All read v_transactions_flat through `reportScope`, so they agree with v_cashflow_monthly and the
 * engine's category activity (see test/reports.test.ts).
 */
import { sql } from "drizzle-orm";
import { divRound, formatMonth, type ISODate, type Milli, type Month } from "@homebase/shared";
import type { DbLike } from "../context";
import { resolvePeriod, type ReportParams, type ResolvedPeriod } from "./params";
import { drillForKey, reportScope } from "./scope";
import { bps, type DrillTarget, type ReportTable } from "./table";

export interface Bucket {
  key: string;
  label: string;
  /** Net spending (outflows − refunds); positive = money spent. */
  amount: Milli;
  drill: DrillTarget;
}

export interface SpendingBreakdownRow extends Bucket {
  /** Group name (category level). */
  groupLabel: string | null;
  /** Share of the total, basis points. */
  shareBps: number;
  /** Outflow lines (transactions / split lines). */
  outflows: number;
}

export interface SpendingBreakdown {
  period: ResolvedPeriod;
  params: ReportParams;
  total: Milli;
  rows: SpendingBreakdownRow[];
  /** Donut slices: the 7 largest positive buckets, then "Other". */
  donut: Bucket[];
  avgMonthly: Milli;
  avgDaily: Milli;
  mostFrequent: { key: string; label: string; outflows: number } | null;
  largestOutflow: { transactionId: string; date: ISODate; payee: string | null; category: string; account: string; amount: Milli } | null;
  table: ReportTable;
}

const OTHER = "Other";

function topWithOther<T extends { key: string; amount: Milli }>(rows: T[], n: number): { top: T[]; rest: T[] } {
  const pos = rows.filter((r) => r.amount > 0n).sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  if (pos.length <= n + 1) return { top: pos, rest: [] };
  return { top: pos.slice(0, n), rest: pos.slice(n) };
}

export async function spendingBreakdownReport(db: DbLike, params: ReportParams): Promise<SpendingBreakdown> {
  const period = resolvePeriod(params);
  const s = await reportScope(db, params, period);
  const [key, label] = params.level === "group" ? [s.groupKey, s.groupLabel] : [s.categoryKey, s.categoryLabel];
  const res = await db.execute<{ key: string; label: string; grp: string | null; amount: bigint; outflows: number; cats: (string | null)[] | null }>(sql`
    SELECT ${key} AS key, ${label} AS label, max(v.group_name) AS grp, (-sum(v.amount_milli))::bigint AS amount,
      (count(*) FILTER (WHERE v.amount_milli < 0))::int AS outflows, array_agg(DISTINCT v.category_id::text) AS cats
    FROM v_transactions_flat v
    WHERE ${s.spend}
    GROUP BY 1, 2
    ORDER BY 4 DESC, 2`);
  const total = res.rows.reduce((t, r) => t + BigInt(r.amount), 0n);
  const rows: SpendingBreakdownRow[] = res.rows.map((r) => {
    const amount = BigInt(r.amount);
    return {
      key: r.key,
      label: r.label,
      groupLabel: params.level === "group" ? null : r.key.startsWith("payee:") ? null : r.grp,
      amount,
      shareBps: bps(amount, total),
      outflows: Number(r.outflows),
      drill: drillForKey(r.key, r.cats),
    };
  });
  const { top, rest } = topWithOther(rows, 7);
  const donut: Bucket[] = top.map((r) => ({ key: r.key, label: r.label, amount: r.amount, drill: r.drill }));
  if (rest.length) donut.push({ key: "other", label: OTHER, amount: rest.reduce((t, r) => t + r.amount, 0n), drill: {} });
  let mostFrequent: SpendingBreakdown["mostFrequent"] = null;
  for (const r of rows) if (r.outflows > 0 && (!mostFrequent || r.outflows > mostFrequent.outflows)) mostFrequent = { key: r.key, label: r.label, outflows: r.outflows };
  const big = await db.execute<{ transaction_id: string; date: string; payee: string | null; category: string; account: string; amount: bigint }>(sql`
    SELECT v.transaction_id, v.date::text AS date, v.payee_name AS payee, ${s.categoryLabel} AS category, v.account_name AS account, v.amount_milli AS amount
    FROM v_transactions_flat v
    WHERE ${s.spend} AND v.amount_milli < 0
    ORDER BY v.amount_milli ASC, v.date DESC
    LIMIT 1`);
  const b = big.rows[0];
  const levelLabel = params.level === "group" ? "Group" : "Category";
  return {
    period,
    params,
    total,
    rows,
    donut,
    avgMonthly: divRound(total, BigInt(period.months.length)),
    avgDaily: divRound(total, BigInt(period.days)),
    mostFrequent,
    largestOutflow: b ? { transactionId: b.transaction_id, date: b.date, payee: b.payee, category: b.category, account: b.account, amount: -BigInt(b.amount) } : null,
    table: {
      columns: [
        { key: "label", label: levelLabel, kind: "text" },
        ...(params.level === "category" ? [{ key: "group", label: "Group", kind: "text" as const, secondary: true }] : []),
        { key: "outflows", label: "Outflows", kind: "count", secondary: true },
        { key: "share", label: "Share", kind: "bps" },
        { key: "amount", label: "Spent", kind: "money" },
      ],
      rows: rows.map((r) => ({ key: r.key, drill: r.drill, cells: { label: r.label, group: r.groupLabel, outflows: r.outflows, share: r.shareBps, amount: r.amount } })),
      total: { label: "Total", group: null, outflows: rows.reduce((t, r) => t + r.outflows, 0), share: total === 0n ? 0 : 10_000, amount: total },
    },
  };
}

// ── trends ──────────────────────────────────────────────────────────────────

export interface SpendingTrends {
  period: ResolvedPeriod;
  params: ReportParams;
  /** Stack order (largest first); the last may be "Other". */
  series: (Bucket & { avgMonthly: Milli })[];
  months: { month: Month; total: Milli; values: Record<string, Milli> }[];
  total: Milli;
  /** Average monthly total over the period's months. */
  average: Milli;
  table: ReportTable;
}

export async function spendingTrendsReport(db: DbLike, params: ReportParams): Promise<SpendingTrends> {
  const period = resolvePeriod(params);
  const s = await reportScope(db, params, period);
  const [key, label] = params.level === "group" ? [s.groupKey, s.groupLabel] : [s.categoryKey, s.categoryLabel];
  const res = await db.execute<{ month: string; key: string; label: string; amount: bigint; cats: (string | null)[] | null }>(sql`
    SELECT v.month::text AS month, ${key} AS key, ${label} AS label, (-sum(v.amount_milli))::bigint AS amount, array_agg(DISTINCT v.category_id::text) AS cats
    FROM v_transactions_flat v
    WHERE ${s.spend}
    GROUP BY 1, 2, 3`);
  const totals = new Map<string, Bucket>();
  for (const r of res.rows) {
    const t = totals.get(r.key) ?? { key: r.key, label: r.label, amount: 0n, drill: drillForKey(r.key, r.cats) };
    t.amount += BigInt(r.amount);
    if (r.cats) t.drill = drillForKey(r.key, [...(t.drill.categoryIds ?? []), ...r.cats]);
    totals.set(r.key, t);
  }
  const { top } = topWithOther([...totals.values()], 7);
  const topKeys = new Set(top.map((t) => t.key));
  // Negative-net buckets (refund-only) fold into Other so the stack still sums to the month total.
  const otherKeys = new Set([...totals.keys()].filter((k) => !topKeys.has(k)));
  const n = BigInt(period.months.length);
  const series: SpendingTrends["series"] = top.map((t) => ({ ...t, avgMonthly: divRound(t.amount, n) }));
  if (otherKeys.size) {
    const amt = [...otherKeys].reduce((a, k) => a + totals.get(k)!.amount, 0n);
    series.push({ key: "other", label: OTHER, amount: amt, drill: {}, avgMonthly: divRound(amt, n) });
  }
  const months = period.months.map((m) => ({ month: m, total: 0n, values: Object.fromEntries(series.map((x) => [x.key, 0n])) as Record<string, Milli> }));
  const byMonth = new Map(months.map((m) => [m.month, m]));
  for (const r of res.rows) {
    const m = byMonth.get(r.month);
    if (!m) continue;
    const k = topKeys.has(r.key) ? r.key : "other";
    m.values[k] = (m.values[k] ?? 0n) + BigInt(r.amount);
    m.total += BigInt(r.amount);
  }
  const total = months.reduce((a, m) => a + m.total, 0n);
  const all = [...totals.values()].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  const perKeyMonth = new Map<string, Map<string, Milli>>();
  for (const r of res.rows) {
    const mm = perKeyMonth.get(r.key) ?? new Map<string, Milli>();
    mm.set(r.month, (mm.get(r.month) ?? 0n) + BigInt(r.amount));
    perKeyMonth.set(r.key, mm);
  }
  return {
    period,
    params,
    series,
    months,
    total,
    average: divRound(total, n),
    table: {
      columns: [
        { key: "label", label: params.level === "group" ? "Group" : "Category", kind: "text" },
        { key: "avg", label: "Avg / month", kind: "money" },
        { key: "share", label: "Share", kind: "bps", secondary: true },
        { key: "amount", label: "Total", kind: "money" },
        ...period.months.map((m) => ({ key: m, label: formatMonth(m, "short"), kind: "money" as const, csvOnly: true })),
      ],
      rows: all.map((t) => ({
        key: t.key,
        drill: t.drill,
        cells: {
          label: t.label,
          avg: divRound(t.amount, n),
          share: bps(t.amount, total),
          amount: t.amount,
          ...Object.fromEntries(period.months.map((m) => [m, perKeyMonth.get(t.key)?.get(m) ?? 0n])),
        },
      })),
      total: { label: "Total", avg: divRound(total, n), share: total === 0n ? 0 : 10_000, amount: total, ...Object.fromEntries(months.map((m) => [m.month, m.total])) },
    },
  };
}

// ── payees ──────────────────────────────────────────────────────────────────

export interface PayeeRow {
  key: string;
  payeeId: string | null;
  name: string;
  /** Net spending. */
  amount: Milli;
  transactions: number;
  avgPerTransaction: Milli;
  lastDate: ISODate;
  shareBps: number;
  drill: DrillTarget;
}

export interface PayeesReport {
  period: ResolvedPeriod;
  params: ReportParams;
  total: Milli;
  payeeCount: number;
  bySpend: PayeeRow[];
  byFrequency: PayeeRow[];
  /** Monthly spending of the top 5 payees by spend. */
  trend: { series: { key: string; label: string }[]; months: { month: Month; values: Record<string, Milli> }[] };
  table: ReportTable;
}

export async function payeesReport(db: DbLike, params: ReportParams, opts: { limit?: number } = {}): Promise<PayeesReport> {
  const period = resolvePeriod(params);
  const s = await reportScope(db, params, period);
  const limit = opts.limit ?? 25;
  const res = await db.execute<{ payee_id: string | null; name: string; amount: bigint; n: number; last: string }>(sql`
    SELECT v.payee_id::text AS payee_id, coalesce(max(v.payee_name), '(no payee)') AS name, (-sum(v.amount_milli))::bigint AS amount,
      count(DISTINCT v.transaction_id)::int AS n, max(v.date)::text AS last
    FROM v_transactions_flat v
    WHERE ${s.spend}
    GROUP BY v.payee_id`);
  const total = res.rows.reduce((t, r) => t + BigInt(r.amount), 0n);
  const all: PayeeRow[] = res.rows.map((r) => {
    const amount = BigInt(r.amount);
    return {
      key: r.payee_id ? `payee:${r.payee_id}` : "payee:none",
      payeeId: r.payee_id,
      name: r.name,
      amount,
      transactions: Number(r.n),
      avgPerTransaction: Number(r.n) ? divRound(amount, BigInt(r.n)) : 0n,
      lastDate: r.last,
      shareBps: bps(amount, total),
      drill: r.payee_id ? { payeeIds: [r.payee_id] } : {},
    };
  });
  const cmpAmt = (a: PayeeRow, b: PayeeRow) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : a.name.localeCompare(b.name));
  const bySpend = all.slice().sort(cmpAmt).slice(0, limit);
  const byFrequency = all
    .slice()
    .sort((a, b) => b.transactions - a.transactions || cmpAmt(a, b))
    .slice(0, limit);
  const top5 = bySpend.filter((p) => p.payeeId).slice(0, 5);
  const trendRows = top5.length
    ? await db.execute<{ month: string; payee_id: string; amount: bigint }>(sql`
        SELECT v.month::text AS month, v.payee_id::text AS payee_id, (-sum(v.amount_milli))::bigint AS amount
        FROM v_transactions_flat v
        WHERE ${s.spend} AND v.payee_id IN ${top5.map((p) => p.payeeId!)}
        GROUP BY 1, 2`)
    : { rows: [] };
  const months = period.months.map((m) => ({ month: m, values: Object.fromEntries(top5.map((p) => [p.key, 0n])) as Record<string, Milli> }));
  const mi = new Map(months.map((m) => [m.month, m]));
  for (const r of trendRows.rows) {
    const m = mi.get(r.month);
    if (m) m.values[`payee:${r.payee_id}`] = BigInt(r.amount);
  }
  return {
    period,
    params,
    total,
    payeeCount: all.length,
    bySpend,
    byFrequency,
    trend: { series: top5.map((p) => ({ key: p.key, label: p.name })), months },
    table: {
      columns: [
        { key: "name", label: "Payee", kind: "text" },
        { key: "transactions", label: "Count", kind: "count" },
        { key: "avg", label: "Avg each", kind: "money", secondary: true },
        { key: "last", label: "Last", kind: "date", secondary: true },
        { key: "amount", label: "Spent", kind: "money" },
      ],
      rows: all
        .slice()
        .sort(cmpAmt)
        .map((p) => ({ key: p.key, drill: p.drill, cells: { name: p.name, transactions: p.transactions, avg: p.avgPerTransaction, last: p.lastDate, amount: p.amount } })),
      total: { name: "Total", transactions: all.reduce((t, p) => t + p.transactions, 0), avg: null, last: null, amount: total },
    },
  };
}
