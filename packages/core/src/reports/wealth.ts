/** §13 reports 4 and 9: net worth over time and investment growth (contributions vs market change). */
import { sql } from "drizzle-orm";
import { addDays, addMonths, lastDayOfMonth, monthOf, monthsBetween, type AccountKind, type ISODate, type Milli, type Month } from "@homebase/shared";
import type { DbLike } from "../context";
import { investmentGrowth, type GrowthMonth } from "../wealth/investments";
import { balancesAt, householdEntityId, sampleDates, type AccountBalanceAt, type Granularity } from "../wealth/netWorth";
import { resolvePeriod, type ReportParams, type ResolvedPeriod } from "./params";
import { bps, type ReportTable } from "./table";

interface AccountMeta {
  id: string;
  name: string;
  kind: AccountKind;
  entityId: string;
  onBudget: boolean;
  closed: boolean;
}

/** Non-deleted accounts in the report's entity scope (and account filter). */
export async function scopedAccounts(db: DbLike, params: ReportParams): Promise<AccountMeta[]> {
  const hh = await householdEntityId(db);
  const r = await db.execute<{ id: string; name: string; kind: AccountKind; entity_id: string; on_budget: boolean; closed: boolean }>(sql`
    SELECT id, name, kind, entity_id, on_budget, closed FROM accounts WHERE deleted_at IS NULL ORDER BY sort, name`);
  return r.rows
    .filter((a) => params.entity === "all" || !hh || (params.entity === "household" ? a.entity_id === hh : a.entity_id !== hh))
    .filter((a) => !params.accountIds?.length || params.accountIds.includes(a.id))
    .map((a) => ({ id: a.id, name: a.name, kind: a.kind, entityId: a.entity_id, onBudget: a.on_budget, closed: a.closed }));
}

// ── net worth ───────────────────────────────────────────────────────────────

export interface NetWorthReportPoint {
  date: ISODate;
  assets: Milli;
  /** Negative balances, as a negative number (so a stacked area sits below zero). */
  liabilities: Milli;
  netWorth: Milli;
}

export interface NetWorthReport {
  period: ResolvedPeriod;
  params: ReportParams;
  granularity: Granularity;
  points: NetWorthReportPoint[];
  start: NetWorthReportPoint;
  end: NetWorthReportPoint;
  change: Milli;
  /** Basis points of |start net worth| (null when it was 0). */
  changeBps: number | null;
  accounts: { accountId: string; name: string; kind: AccountKind; start: Milli; end: Milli; change: Milli }[];
  table: ReportTable;
}

function pointOf(date: ISODate, rows: AccountBalanceAt[]): NetWorthReportPoint {
  let assets = 0n;
  let liabilities = 0n;
  for (const r of rows) {
    if (r.balance >= 0n) assets += r.balance;
    else liabilities += r.balance;
  }
  return { date, assets, liabilities, netWorth: assets + liabilities };
}

export async function netWorthReport(db: DbLike, params: ReportParams): Promise<NetWorthReport> {
  const period = resolvePeriod(params);
  const accts = await scopedAccounts(db, params);
  const granularity: Granularity = period.days <= 45 ? "day" : period.days <= 120 ? "week" : "month";
  const dayBefore = addDays(period.from, -1);
  // monthly: one point per month end (the last one capped at `to`), so every tick is a distinct month
  const dates = granularity === "month" ? period.months.map((m) => (lastDayOfMonth(m) < period.to ? lastDayOfMonth(m) : period.to)) : sampleDates(period.from, period.to, granularity);
  const ids = accts.map((a) => a.id);
  const bal = ids.length ? await balancesAt(db, [...new Set([dayBefore, ...dates])], { includeBusiness: true, accountIds: ids }) : [];
  const byDate = new Map<ISODate, AccountBalanceAt[]>();
  for (const b of bal) {
    const arr = byDate.get(b.date) ?? [];
    arr.push(b);
    byDate.set(b.date, arr);
  }
  const points = dates.map((d) => pointOf(d, byDate.get(d) ?? []));
  const start = pointOf(dayBefore, byDate.get(dayBefore) ?? []);
  const end = points[points.length - 1] ?? start;
  const change = end.netWorth - start.netWorth;
  const base = start.netWorth < 0n ? -start.netWorth : start.netWorth;
  const at = (d: ISODate, id: string) => byDate.get(d)?.find((b) => b.accountId === id)?.balance ?? 0n;
  const rows = accts
    .map((a) => ({ accountId: a.id, name: a.name, kind: a.kind, start: at(dayBefore, a.id), end: at(end.date, a.id) }))
    .map((a) => ({ ...a, change: a.end - a.start }))
    .filter((a) => a.start !== 0n || a.end !== 0n)
    .sort((a, b) => (b.end > a.end ? 1 : b.end < a.end ? -1 : 0));
  return {
    period,
    params,
    granularity,
    points,
    start,
    end,
    change,
    changeBps: base === 0n ? null : bps(change, base),
    accounts: rows,
    table: {
      columns: [
        { key: "name", label: "Account", kind: "text" },
        { key: "kind", label: "Kind", kind: "text", secondary: true },
        { key: "start", label: "Start", kind: "money", secondary: true },
        { key: "change", label: "Change", kind: "money", signed: true },
        { key: "end", label: "Balance", kind: "money" },
      ],
      rows: rows.map((a) => ({ key: a.accountId, drill: { accountIds: [a.accountId] }, cells: { name: a.name, kind: a.kind.replace(/_/g, " "), start: a.start, change: a.change, end: a.end } })),
      total: { name: "Net worth", kind: null, start: start.netWorth, change, end: end.netWorth },
    },
  };
}

// ── investment growth ───────────────────────────────────────────────────────

const INVESTMENT_KINDS = new Set<AccountKind>(["brokerage", "retirement", "hsa", "crypto"]);

export interface InvestmentGrowthReport {
  period: ResolvedPeriod;
  params: ReportParams;
  accounts: { accountId: string; name: string; kind: AccountKind; months: GrowthMonth[]; totals: { change: Milli; contributions: Milli; marketChange: Milli }; end: Milli }[];
  /** Summed over `accounts` (or the one selected with params.accountId). */
  months: GrowthMonth[];
  totals: { start: Milli; end: Milli; change: Milli; contributions: Milli; marketChange: Milli };
  /** True when every account has a known contribution source. */
  contributionsKnown: boolean;
  table: ReportTable;
}

export async function investmentGrowthReport(db: DbLike, params: ReportParams): Promise<InvestmentGrowthReport> {
  const period = resolvePeriod(params);
  const today = period.today;
  const all = (await scopedAccounts(db, { ...params, accountIds: undefined })).filter((a) => INVESTMENT_KINDS.has(a.kind));
  let accts = all.filter((a) => !params.accountIds?.length || params.accountIds.includes(a.id));
  if (params.accountId) accts = all.filter((a) => a.id === params.accountId);
  const cur = monthOf(today);
  const firstMonth = monthOf(period.from);
  const n = Math.max(monthsBetween(firstMonth, cur), 1);
  const inPeriod = (m: Month) => m >= firstMonth && m <= monthOf(period.to);
  const perAccount: InvestmentGrowthReport["accounts"] = [];
  for (const a of accts) {
    const g = await investmentGrowth(db, a.id, n, { today });
    const months = g.months.filter((m) => inPeriod(m.month));
    perAccount.push({
      accountId: a.id,
      name: a.name,
      kind: a.kind,
      months,
      totals: {
        change: months.reduce((t, m) => t + m.change, 0n),
        contributions: months.reduce((t, m) => t + m.contributions, 0n),
        marketChange: months.reduce((t, m) => t + m.marketChange, 0n),
      },
      end: months[months.length - 1]?.end ?? 0n,
    });
  }
  const monthList: Month[] = [];
  for (let m = firstMonth; m <= monthOf(period.to) && m <= cur; m = addMonths(m, 1)) monthList.push(m);
  const months: GrowthMonth[] = monthList.map((m) => {
    const ms = perAccount.map((a) => a.months.find((x) => x.month === m)).filter((x): x is GrowthMonth => !!x);
    const known = ms.length > 0 && ms.every((x) => x.contributionsKnown);
    return {
      month: m,
      start: ms.reduce((t, x) => t + x.start, 0n),
      end: ms.reduce((t, x) => t + x.end, 0n),
      change: ms.reduce((t, x) => t + x.change, 0n),
      contributions: ms.reduce((t, x) => t + x.contributions, 0n),
      marketChange: ms.reduce((t, x) => t + x.marketChange, 0n),
      contributionsKnown: known,
      label: known ? "market change" : "market change + unknown contributions",
      partial: ms.some((x) => x.partial),
    };
  });
  const totals = {
    start: months[0]?.start ?? 0n,
    end: months[months.length - 1]?.end ?? 0n,
    change: months.reduce((t, m) => t + m.change, 0n),
    contributions: months.reduce((t, m) => t + m.contributions, 0n),
    marketChange: months.reduce((t, m) => t + m.marketChange, 0n),
  };
  return {
    period,
    params,
    accounts: perAccount.sort((a, b) => (b.end > a.end ? 1 : b.end < a.end ? -1 : 0)),
    months,
    totals,
    contributionsKnown: perAccount.every((a) => a.months.every((m) => m.contributionsKnown)),
    table: {
      columns: [
        { key: "month", label: "Month", kind: "month" },
        { key: "contributions", label: "Contributions", kind: "money" },
        { key: "market", label: "Market", kind: "money", signed: true },
        { key: "change", label: "Change", kind: "money", secondary: true, signed: true },
        { key: "end", label: "Balance", kind: "money", secondary: true },
      ],
      rows: months.map((m) => ({ key: m.month, cells: { month: m.month, contributions: m.contributions, market: m.marketChange, change: m.change, end: m.end } })),
      total: { month: "Total", contributions: totals.contributions, market: totals.marketChange, change: totals.change, end: totals.end },
    },
  };
}
