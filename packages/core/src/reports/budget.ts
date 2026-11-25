/**
 * §13 reports 5, 6 and 10 — Age of Money over time, category detail and budget performance — from the
 * engine result (`ensureFresh`, which also refreshes budget_month_cache / v_month_category).
 * These are budget-wide: the engine's numbers don't depend on the account filter, and the business has no budget.
 */
import { sql } from "drizzle-orm";
import type { BudgetResult, CategoryMonth } from "@homebase/engine";
import { divRound, monthOf, today as localToday, type Milli, type Month } from "@homebase/shared";
import { ensureFresh } from "../budget/cache";
import type { DbLike } from "../context";
import { NotFoundError } from "../errors";
import { resolvePeriod, type ReportParams, type ResolvedPeriod } from "./params";
import type { ReportTable } from "./table";

export interface BudgetCategoryMeta {
  id: string;
  name: string;
  kind: string;
  hidden: boolean;
  deleted: boolean;
  groupId: string;
  groupName: string;
  groupSort: number;
  sort: number;
}

export async function budgetCategories(db: DbLike): Promise<BudgetCategoryMeta[]> {
  const r = await db.execute<{ id: string; name: string; kind: string; hidden: boolean; deleted: boolean; group_id: string; group_name: string; gsort: number; sort: number }>(sql`
    SELECT c.id, c.name, c.kind::text AS kind, (c.hidden OR g.hidden) AS hidden, (c.deleted_at IS NOT NULL OR g.deleted_at IS NOT NULL) AS deleted,
      g.id AS group_id, g.name AS group_name, g.sort AS gsort, c.sort
    FROM categories c JOIN category_groups g ON g.id = c.group_id
    ORDER BY g.sort, c.sort, c.name`);
  return r.rows.map((x) => ({ id: x.id, name: x.name, kind: x.kind, hidden: x.hidden, deleted: x.deleted, groupId: x.group_id, groupName: x.group_name, groupSort: Number(x.gsort), sort: Number(x.sort) }));
}

/** Engine months of the period that exist in the result and aren't in the future. */
function periodMonths(result: BudgetResult, period: ResolvedPeriod): Month[] {
  const cur = monthOf(period.today);
  const have = new Set(result.monthList);
  return period.months.filter((m) => m <= cur && have.has(m));
}

async function engine(db: DbLike, params: ReportParams): Promise<{ result: BudgetResult; period: ResolvedPeriod }> {
  const today = params.today ?? localToday();
  const period = resolvePeriod({ ...params, today });
  const { result } = await ensureFresh(db, today);
  return { result, period };
}

// ── age of money ────────────────────────────────────────────────────────────

export interface AgeOfMoneyReport {
  period: ResolvedPeriod;
  params: ReportParams;
  months: { month: Month; days: number | null }[];
  /** Latest month with a value. */
  current: number | null;
  /** current − first month with a value in the period. */
  change: number | null;
  min: { month: Month; days: number } | null;
  max: { month: Month; days: number } | null;
  table: ReportTable;
}

export async function ageOfMoneyReport(db: DbLike, params: ReportParams): Promise<AgeOfMoneyReport> {
  const { result, period } = await engine(db, params);
  const months = periodMonths(result, period).map((m) => ({ month: m, days: result.months[m]!.ageOfMoney }));
  const vals = months.filter((m): m is { month: Month; days: number } => m.days !== null);
  const current = vals.length ? vals[vals.length - 1]!.days : null;
  let min: AgeOfMoneyReport["min"] = null;
  let max: AgeOfMoneyReport["max"] = null;
  for (const v of vals) {
    if (!min || v.days < min.days) min = v;
    if (!max || v.days > max.days) max = v;
  }
  return {
    period,
    params,
    months,
    current,
    change: vals.length >= 2 ? current! - vals[0]!.days : null,
    min,
    max,
    table: {
      columns: [
        { key: "month", label: "Month", kind: "month" },
        { key: "days", label: "Age of Money", kind: "days" },
        { key: "change", label: "Change", kind: "days", secondary: true },
      ],
      rows: months.map((m, i) => {
        const prev = i > 0 ? months[i - 1]!.days : null;
        return { key: m.month, cells: { month: m.month, days: m.days, change: m.days !== null && prev !== null ? m.days - prev : null } };
      }),
    },
  };
}

// ── category detail ─────────────────────────────────────────────────────────

export interface CategoryDetailMonth {
  month: Month;
  assigned: Milli;
  activity: Milli;
  /** −activity: positive = spent. */
  spent: Milli;
  available: Milli;
  needed: Milli;
  underfunded: Milli;
  hasTarget: boolean;
  /** Target in effect and fully funded (needed > 0 and nothing left underfunded). */
  metTarget: boolean;
  overspent: boolean;
}

export interface CategoryDetailReport {
  period: ResolvedPeriod;
  params: ReportParams;
  /** The category, or the group at group level. */
  subject: { id: string; name: string; groupName: string | null; level: "category" | "group"; categoryIds: string[] } | null;
  /** Choices for the picker (category level: categories; group level: groups). */
  options: { id: string; label: string; group: string | null }[];
  months: CategoryDetailMonth[];
  avgAssigned: Milli;
  avgSpent: Milli;
  totalSpent: Milli;
  monthsWithTarget: number;
  monthsMetTarget: number;
  table: ReportTable;
}

const BUDGET_KINDS = new Set(["normal", "cc_payment"]);
const ZERO = (id: string): Pick<CategoryMonth, "categoryId" | "assigned" | "activity" | "available" | "needed" | "underfunded" | "hasTarget"> => ({
  categoryId: id,
  assigned: 0n,
  activity: 0n,
  available: 0n,
  needed: 0n,
  underfunded: 0n,
  hasTarget: false,
});

export async function categoryDetailReport(db: DbLike, params: ReportParams): Promise<CategoryDetailReport> {
  const { result, period } = await engine(db, params);
  const cats = (await budgetCategories(db)).filter((c) => BUDGET_KINDS.has(c.kind) && !c.deleted);
  const group = params.level === "group";
  const options = group
    ? [...new Map(cats.map((c) => [c.groupId, { id: c.groupId, label: c.groupName, group: null }])).values()]
    : cats.filter((c) => !c.hidden || c.id === params.categoryId).map((c) => ({ id: c.id, label: c.name, group: c.groupName }));
  const months = periodMonths(result, period);
  let subjectId = params.categoryId && options.some((o) => o.id === params.categoryId) ? params.categoryId : undefined;
  if (params.categoryId && !subjectId) throw new NotFoundError(group ? "category group" : "category", params.categoryId);
  if (!subjectId) {
    // default: the biggest spender over the period
    let best: { id: string; spent: Milli } | null = null;
    for (const o of options) {
      const ids = group ? cats.filter((c) => c.groupId === o.id && c.kind === "normal").map((c) => c.id) : [o.id];
      let spent = 0n;
      for (const m of months) for (const id of ids) spent -= result.months[m]!.categories[id]?.activity ?? 0n;
      if (!best || spent > best.spent) best = { id: o.id, spent };
    }
    subjectId = best?.id;
  }
  const empty = { avgAssigned: 0n, avgSpent: 0n, totalSpent: 0n, monthsWithTarget: 0, monthsMetTarget: 0 };
  if (!subjectId) return { period, params, subject: null, options, months: [], ...empty, table: { columns: [], rows: [] } };
  const ids = group ? cats.filter((c) => c.groupId === subjectId).map((c) => c.id) : [subjectId];
  const meta = group ? cats.find((c) => c.groupId === subjectId)! : cats.find((c) => c.id === subjectId)!;
  const rows: CategoryDetailMonth[] = months.map((m) => {
    const cms = ids.map((id) => result.months[m]!.categories[id] ?? ZERO(id));
    const sum = (f: (c: (typeof cms)[number]) => Milli) => cms.reduce((t, c) => t + f(c), 0n);
    const targeted = cms.filter((c) => c.hasTarget && c.needed > 0n);
    const activity = sum((c) => c.activity);
    return {
      month: m,
      assigned: sum((c) => c.assigned),
      activity,
      spent: -activity,
      available: sum((c) => c.available),
      needed: sum((c) => c.needed),
      underfunded: sum((c) => c.underfunded),
      hasTarget: targeted.length > 0,
      metTarget: targeted.length > 0 && targeted.every((c) => c.underfunded === 0n),
      overspent: cms.some((c) => c.available < 0n),
    };
  });
  const n = BigInt(Math.max(rows.length, 1));
  const totalSpent = rows.reduce((t, r) => t + r.spent, 0n);
  return {
    period,
    params,
    subject: { id: subjectId, name: group ? meta.groupName : meta.name, groupName: group ? null : meta.groupName, level: group ? "group" : "category", categoryIds: ids },
    options,
    months: rows,
    avgAssigned: divRound(rows.reduce((t, r) => t + r.assigned, 0n), n),
    avgSpent: divRound(totalSpent, n),
    totalSpent,
    monthsWithTarget: rows.filter((r) => r.hasTarget).length,
    monthsMetTarget: rows.filter((r) => r.metTarget).length,
    table: {
      columns: [
        { key: "month", label: "Month", kind: "month" },
        { key: "assigned", label: "Assigned", kind: "money" },
        { key: "spent", label: "Spent", kind: "money" },
        { key: "available", label: "Available", kind: "money", secondary: true },
        { key: "target", label: "Target", kind: "text", secondary: true },
      ],
      rows: rows.map((r) => ({
        key: r.month,
        drill: { categoryIds: ids, from: r.month, to: lastOfMonth(r.month, period.to) },
        cells: { month: r.month, assigned: r.assigned, spent: r.spent, available: r.available, target: r.hasTarget ? (r.metTarget ? "Met" : "Short") : null },
      })),
      total: { month: "Average", assigned: divRound(rows.reduce((t, r) => t + r.assigned, 0n), n), spent: divRound(totalSpent, n), available: null, target: `${rows.filter((r) => r.metTarget).length} of ${rows.filter((r) => r.hasTarget).length} met` },
    },
  };
}

function lastOfMonth(m: Month, cap: string): string {
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  const d = `${m.slice(0, 8)}${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, "0")}`;
  return d > cap ? cap : d;
}

// ── budget performance ──────────────────────────────────────────────────────

export interface BudgetPerformanceRow {
  key: string;
  label: string;
  groupLabel: string | null;
  categoryIds: string[];
  months: number;
  monthsOverspent: number;
  /** monthsOverspent / months, basis points. */
  overspentBps: number;
  /** Mean overspend (−available) over the overspent months. */
  avgOverspend: Milli;
  /** Months where spending ran past that month's assignment (covered by carry-over or moves, or not). */
  monthsOverAssigned: number;
  overAssignedBps: number;
  /** Mean (spent − assigned) over those months. */
  avgOverAssigned: Milli;
  avgAssigned: Milli;
  avgSpent: Milli;
  /** Average monthly spending rounded up to whole dollars. */
  suggested: Milli;
  /** suggested − avgAssigned. */
  change: Milli;
}

export interface BudgetPerformanceReport {
  period: ResolvedPeriod;
  params: ReportParams;
  /** Months evaluated (complete months; the current month only when it is the whole period). */
  months: Month[];
  rows: BudgetPerformanceRow[];
  totals: { avgAssigned: Milli; avgSpent: Milli; suggested: Milli; overspentCategoryMonths: number };
  table: ReportTable;
}

const ceilDollar = (m: Milli) => (m <= 0n ? 0n : ((m + 999n) / 1000n) * 1000n);

export async function budgetPerformanceReport(db: DbLike, params: ReportParams): Promise<BudgetPerformanceReport> {
  const { result, period } = await engine(db, params);
  const cur = monthOf(period.today);
  let months = periodMonths(result, period);
  if (months.length > 1) months = months.filter((m) => m < cur);
  const cats = (await budgetCategories(db)).filter((c) => c.kind === "normal" && !c.deleted);
  const group = params.level === "group";
  const subjects = group
    ? [...new Map(cats.map((c) => [c.groupId, { key: `group:${c.groupId}`, label: c.groupName, groupLabel: null as string | null, ids: cats.filter((x) => x.groupId === c.groupId).map((x) => x.id) }])).values()]
    : cats.map((c) => ({ key: `category:${c.id}`, label: c.name, groupLabel: c.groupName as string | null, ids: [c.id] }));
  const n = BigInt(Math.max(months.length, 1));
  const rows: BudgetPerformanceRow[] = [];
  for (const s of subjects) {
    let assigned = 0n;
    let spent = 0n;
    let over = 0n;
    let monthsOver = 0;
    let overPlan = 0n;
    let monthsOverPlan = 0;
    let touched = false;
    for (const m of months) {
      let monthOver = 0n;
      let mAssigned = 0n;
      let mSpent = 0n;
      for (const id of s.ids) {
        const cm = result.months[m]!.categories[id];
        if (!cm) continue;
        if (cm.assigned !== 0n || cm.activity !== 0n) touched = true;
        assigned += cm.assigned;
        spent -= cm.activity;
        mAssigned += cm.assigned;
        mSpent -= cm.activity;
        if (cm.available < 0n) monthOver -= cm.available;
      }
      if (mSpent > mAssigned && mSpent > 0n) {
        monthsOverPlan++;
        overPlan += mSpent - mAssigned;
      }
      if (monthOver > 0n) {
        monthsOver++;
        over += monthOver;
      }
    }
    if (!touched) continue;
    const avgAssigned = divRound(assigned, n);
    const avgSpent = divRound(spent, n);
    const suggested = ceilDollar(avgSpent);
    rows.push({
      key: s.key,
      label: s.label,
      groupLabel: s.groupLabel,
      categoryIds: s.ids,
      months: months.length,
      monthsOverspent: monthsOver,
      overspentBps: months.length ? Math.round((monthsOver * 10_000) / months.length) : 0,
      avgOverspend: monthsOver ? divRound(over, BigInt(monthsOver)) : 0n,
      monthsOverAssigned: monthsOverPlan,
      overAssignedBps: months.length ? Math.round((monthsOverPlan * 10_000) / months.length) : 0,
      avgOverAssigned: monthsOverPlan ? divRound(overPlan, BigInt(monthsOverPlan)) : 0n,
      avgAssigned,
      avgSpent,
      suggested,
      change: suggested - avgAssigned,
    });
  }
  rows.sort(
    (a, b) =>
      b.overspentBps - a.overspentBps ||
      b.overAssignedBps - a.overAssignedBps ||
      (b.avgOverAssigned > a.avgOverAssigned ? 1 : b.avgOverAssigned < a.avgOverAssigned ? -1 : 0) ||
      a.label.localeCompare(b.label),
  );
  const sum = (f: (r: BudgetPerformanceRow) => Milli) => rows.reduce((t, r) => t + f(r), 0n);
  return {
    period,
    params,
    months,
    rows,
    totals: { avgAssigned: sum((r) => r.avgAssigned), avgSpent: sum((r) => r.avgSpent), suggested: sum((r) => r.suggested), overspentCategoryMonths: rows.reduce((t, r) => t + r.monthsOverspent, 0) },
    table: {
      columns: [
        { key: "label", label: group ? "Group" : "Category", kind: "text" },
        { key: "overspent", label: "Overspent", kind: "bps", secondary: true },
        { key: "avgOverspend", label: "Avg overspend", kind: "money", secondary: true },
        { key: "overPlan", label: "Over plan", kind: "bps" },
        { key: "avgOverPlan", label: "Avg over plan", kind: "money", secondary: true },
        { key: "avgAssigned", label: "Avg assigned", kind: "money", secondary: true },
        { key: "avgSpent", label: "Avg spent", kind: "money", secondary: true },
        { key: "suggested", label: "Suggested", kind: "money" },
      ],
      rows: rows.map((r) => ({
        key: r.key,
        drill: { categoryIds: r.categoryIds, from: months[0] ?? period.from, to: months.length ? lastOfMonth(months[months.length - 1]!, period.to) : period.to },
        cells: { label: r.label, overspent: r.overspentBps, avgOverspend: r.avgOverspend, overPlan: r.overAssignedBps, avgOverPlan: r.avgOverAssigned, avgAssigned: r.avgAssigned, avgSpent: r.avgSpent, suggested: r.suggested },
      })),
      total: { label: "Total", overspent: null, avgOverspend: null, overPlan: null, avgOverPlan: null, avgAssigned: sum((r) => r.avgAssigned), avgSpent: sum((r) => r.avgSpent), suggested: sum((r) => r.suggested) },
    },
  };
}

