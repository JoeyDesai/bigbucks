/**
 * Read models for the Plan screen (spec §12.1) and the category sheet: `getBudgetMonth`, `categoryDetail`.
 * Numbers come from the engine cache (recomputed first when stale); engine detail the cache schema
 * doesn't hold (status labels, cash/credit spending, target progress) comes from the memoized engine run.
 */
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  budgetMonthCache,
  budgetMonthSummary,
  categories,
  categoryGroups,
  targets,
  type Category,
  type CategoryGroup,
  type Target,
} from "@homebase/db";
import { ENGINE_VERSION, computeBudget, suggestedCardPayment, type BudgetResult, type CategoryMonth, type CategoryStatus, type MonthResult, type PaymentCategoryDetail } from "@homebase/engine";
import { formatMilli, formatMonth, monthOf, today as localToday, type ISODate, type Milli, type Month } from "@homebase/shared";
import { inOrder, type DbLike } from "../context";
import { NotFoundError } from "../errors";
import { listTransactions, type TransactionRow } from "../transactions/list";
import { ensureFresh } from "./cache";
import { getMonthNotes } from "./operations";
import { loadSnapshot } from "./snapshot";

export type PillColor = "green" | "yellow" | "red" | "gray";

export interface TargetView {
  type: Target["type"];
  amount: Milli;
  cadence: Target["cadence"];
  cadenceEvery: number;
  day: number | null;
  targetDate: string | null;
  percent: string | null;
  incomeBasis: Target["incomeBasis"];
  effectiveFrom: Month;
  snoozed: boolean;
  /** "Set aside $480.00 each month", "Have a balance of $20,000.00 by Dec 2027", … */
  label: string;
}

export interface PlanCategory {
  id: string;
  groupId: string;
  name: string;
  /** lucide-react icon key (kebab-case), null = UI default. */
  icon: string | null;
  kind: Category["kind"];
  hidden: boolean;
  sort: number;
  note: string | null;
  monthNote: string | null;
  linkedAccountId: string | null;
  alwaysReview: boolean;
  assigned: Milli;
  activity: Milli;
  available: Milli;
  carryIn: Milli;
  cashOverspend: Milli;
  creditOverspend: Milli;
  cashSpending: Milli;
  creditSpending: Milli;
  needed: Milli;
  underfunded: Milli;
  overallLeft: Milli;
  pctComplete: number;
  upcoming: Milli;
  hasTarget: boolean;
  snoozed: boolean;
  status: CategoryStatus;
  statusLabel: string;
  pill: PillColor;
  target: TargetView | null;
  payment: (PaymentCategoryDetail & { suggestedPayment: Milli }) | null;
}

export interface PlanGroup {
  id: string;
  name: string;
  sort: number;
  hidden: boolean;
  isSystem: boolean;
  isCreditCardPayments: boolean;
  assigned: Milli;
  activity: Milli;
  available: Milli;
  categories: PlanCategory[];
}

export interface MonthSummary {
  /** Ready to Assign as displayed (assign-ahead already subtracted, §6.2). */
  readyToAssign: Milli;
  /** Raw cumulative RTA for the month (before subtracting future assignments). */
  rtaRaw: Milli;
  rtaState: "positive" | "zero" | "negative";
  assignedInFuture: Milli;
  /** Σ category carry-in (the panel's "Left over from last month"). */
  leftOverFromLastMonth: Milli;
  /** RTA carried from last month (after the negative-RTA rule). */
  rtaLeftOverFromLastMonth: Milli;
  income: Milli;
  inflowFromDebtAccounts: Milli;
  cashOverspendingLastMonth: Milli;
  cashOverspending: Milli;
  /** Σ assigned / activity / available over all categories: leftOver + assigned + activity = available. */
  assigned: Milli;
  activity: Milli;
  available: Milli;
  costToBeMe: Milli;
  underfunded: Milli;
  ageOfMoney: number | null;
}

export interface BudgetMonthView {
  month: Month;
  label: string;
  engineVersion: number;
  /** false when the month is outside the cached range and was computed on the fly. */
  fromCache: boolean;
  /** Visible groups; the Credit Card Payments group is pinned first (§12.1). */
  groups: PlanGroup[];
  /** Hidden categories (excluded from views, still in the math). */
  hidden: PlanCategory[];
  /** The Uncategorized system category, when it has activity or a balance. */
  uncategorized: PlanCategory | null;
  summary: MonthSummary;
  monthNote: string | null;
  /** Earliest / latest months the budget covers (for the month switcher). */
  range: { first: Month | null; last: Month };
}

// ── helpers ─────────────────────────────────────────────────────────────────

const pct = (p: string | null) => (p === null ? "" : `${Number(p)}%`);

export function targetLabel(t: Pick<Target, "type" | "amountMilli" | "cadence" | "cadenceEvery" | "targetDate" | "percent">): string {
  const X = formatMilli(t.amountMilli);
  const by = t.targetDate ? ` by ${formatMonth(monthOf(t.targetDate), "short")}` : "";
  const every = (unit: string) => (t.cadenceEvery > 1 ? `every ${t.cadenceEvery} ${unit}s` : unit === "month" ? "each month" : `each ${unit}`);
  const cadence = t.cadence === "weekly" ? every("week") : t.cadence === "yearly" ? every("year") : t.cadence === "every_n_months" ? `every ${t.cadenceEvery} months` : t.cadence === "none" ? "" : every("month");
  switch (t.type) {
    case "need_set_aside":
      return `Set aside ${X} ${cadence}${t.cadence === "monthly" || t.cadence === "weekly" ? "" : by}`.trim();
    case "need_refill":
      return `Refill up to ${X} ${cadence}`.trim();
    case "balance":
      return `Have a balance of ${X}`;
    case "balance_by_date":
      return `Have a balance of ${X}${by}`;
    case "monthly_builder":
      return `Assign ${X} each month`;
    case "debt":
      return `Pay ${X} each month`;
    case "percent_of_income":
      return `${pct(t.percent)} of income`;
  }
}

export function pillColor(cm: Pick<CategoryMonth, "available" | "cashOverspend" | "status">): PillColor {
  if (cm.available < 0n) return cm.cashOverspend > 0n ? "red" : "yellow";
  if (cm.status === "upcoming") return "yellow";
  return cm.available > 0n ? "green" : "gray";
}

/** Effective (non-removed) target row per category for `month`. */
async function effectiveTargets(db: DbLike, month: Month, categoryIds?: string[]): Promise<Map<string, Target>> {
  const rows = await db
    .select()
    .from(targets)
    .where(categoryIds ? and(lte(targets.effectiveFrom, month), inArray(targets.categoryId, categoryIds)) : lte(targets.effectiveFrom, month))
    .orderBy(targets.categoryId, desc(targets.effectiveFrom));
  const out = new Map<string, Target>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.categoryId)) continue;
    seen.add(r.categoryId);
    if (!r.removed) out.set(r.categoryId, r);
  }
  return out;
}

function toTargetView(t: Target | undefined, month: Month): TargetView | null {
  if (!t) return null;
  return {
    type: t.type,
    amount: t.amountMilli,
    cadence: t.cadence,
    cadenceEvery: t.cadenceEvery,
    day: t.day,
    targetDate: t.targetDate,
    percent: t.percent,
    incomeBasis: t.incomeBasis,
    effectiveFrom: t.effectiveFrom,
    snoozed: t.snoozedMonth === month,
    label: targetLabel(t),
  };
}

const ZERO_CM = (categoryId: string): CategoryMonth => ({
  categoryId,
  carryIn: 0n,
  assigned: 0n,
  activity: 0n,
  available: 0n,
  cashOverspend: 0n,
  creditOverspend: 0n,
  cashSpending: 0n,
  creditSpending: 0n,
  needed: 0n,
  underfunded: 0n,
  overallLeft: 0n,
  pctComplete: 0,
  upcoming: 0n,
  hasTarget: false,
  snoozed: false,
  status: "zero",
  statusLabel: "Zero",
});

async function clearedBalances(db: DbLike, accountIds: string[]): Promise<Map<string, Milli>> {
  if (accountIds.length === 0) return new Map();
  const rows = await db.execute<{ account_id: string; bal: bigint }>(
    sql`SELECT account_id, coalesce(sum(amount_milli), 0)::bigint AS bal FROM transactions
      WHERE deleted_at IS NULL AND cleared IN ('cleared', 'reconciled') AND account_id IN ${accountIds} GROUP BY account_id`,
  );
  return new Map(rows.rows.map((r) => [r.account_id, BigInt(r.bal)]));
}

type CacheRow = typeof budgetMonthCache.$inferSelect;

function buildCategory(c: Category, cm: CategoryMonth, cache: CacheRow | undefined, target: Target | undefined, month: Month, monthNote: string | null, cleared: Map<string, Milli>): PlanCategory {
  // numbers from the cache when present (authoritative, what the views/AI read), detail from the engine
  const n = cache
    ? {
        assigned: cache.assignedMilli,
        activity: cache.activityMilli,
        available: cache.availableMilli,
        carryIn: cache.carryInMilli,
        cashOverspend: cache.cashOverspendMilli,
        creditOverspend: cache.creditOverspendMilli,
        needed: cache.neededMilli,
        underfunded: cache.underfundedMilli,
      }
    : cm;
  return {
    id: c.id,
    groupId: c.groupId,
    name: c.name,
    icon: c.icon,
    kind: c.kind,
    hidden: c.hidden,
    sort: c.sort,
    note: c.note,
    monthNote,
    linkedAccountId: c.linkedAccountId,
    alwaysReview: c.alwaysReview,
    assigned: n.assigned,
    activity: n.activity,
    available: n.available,
    carryIn: n.carryIn,
    cashOverspend: n.cashOverspend,
    creditOverspend: n.creditOverspend,
    cashSpending: cm.cashSpending,
    creditSpending: cm.creditSpending,
    needed: n.needed,
    underfunded: n.underfunded,
    overallLeft: cm.overallLeft,
    pctComplete: cm.pctComplete,
    upcoming: cm.upcoming,
    hasTarget: cm.hasTarget,
    snoozed: cm.snoozed,
    status: cm.status,
    statusLabel: cm.statusLabel,
    pill: pillColor({ available: n.available, cashOverspend: n.cashOverspend, status: cm.status }),
    target: toTargetView(target, month),
    payment: cm.payment ? { ...cm.payment, suggestedPayment: suggestedCardPayment(n.available, cleared.get(cm.payment.accountId) ?? cm.payment.cardBalance) } : null,
  };
}

/** Engine result that contains `month`: the fresh cached run, or an on-the-fly run for months outside it. */
async function resultFor(db: DbLike, month: Month, today: ISODate): Promise<{ result: BudgetResult; mr: MonthResult; fromCache: boolean; first: Month | null; last: Month }> {
  const fresh = await ensureFresh(db, today);
  const first = fresh.state.firstMonth;
  if (fresh.result.months[month]) return { result: fresh.result, mr: fresh.result.months[month]!, fromCache: true, first, last: fresh.state.through };
  const snapshot = await loadSnapshot(db);
  const through = month > fresh.state.through ? month : fresh.state.through;
  const result = computeBudget(snapshot, { through, from: first && month < first ? month : undefined, asOf: today });
  const mr = result.months[month] ?? emptyMonth(month);
  return { result, mr, fromCache: false, first, last: fresh.state.through };
}

function emptyMonth(month: Month): MonthResult {
  return {
    month,
    rta: 0n,
    readyToAssignDisplay: 0n,
    assignedInFuture: 0n,
    leftOverFromLastMonth: 0n,
    income: 0n,
    inflowFromDebtAccounts: 0n,
    cashOverspendingLastMonth: 0n,
    cashOverspending: 0n,
    assigned: 0n,
    activity: 0n,
    available: 0n,
    costToBeMe: 0n,
    underfunded: 0n,
    ageOfMoney: null,
    categories: {},
  };
}

// ── getBudgetMonth ──────────────────────────────────────────────────────────

export interface BudgetMonthOptions {
  today?: ISODate;
}

/** Everything the Plan screen needs for one month (§12.1). */
export async function getBudgetMonth(db: DbLike, month: Month, opts: BudgetMonthOptions = {}): Promise<BudgetMonthView> {
  const today = opts.today ?? localToday();
  const { mr, fromCache, first, last } = await resultFor(db, month, today);
  const [groups, cats, cacheRows, summaryRows, notes, tmap] = await inOrder([
    () => db.select().from(categoryGroups),
    () => db.select().from(categories),
    () => fromCache ? db.select().from(budgetMonthCache).where(and(eq(budgetMonthCache.engineVersion, ENGINE_VERSION), eq(budgetMonthCache.month, month))) : Promise.resolve([] as CacheRow[]),
    () => fromCache ? db.select().from(budgetMonthSummary).where(and(eq(budgetMonthSummary.engineVersion, ENGINE_VERSION), eq(budgetMonthSummary.month, month))) : Promise.resolve([]),
    () => getMonthNotes(db, month),
    () => effectiveTargets(db, month),
  ]);
  const cacheBy = new Map(cacheRows.map((r) => [r.categoryId, r]));
  const cards = cats.filter((c) => c.kind === "cc_payment" && c.linkedAccountId).map((c) => c.linkedAccountId!);
  const cleared = await clearedBalances(db, cards);
  const groupBy = new Map<string, CategoryGroup>(groups.map((g) => [g.id, g]));

  const planGroups = new Map<string, PlanGroup>();
  const hidden: PlanCategory[] = [];
  let uncategorized: PlanCategory | null = null;
  const sortedCats = [...cats].sort((a, b) => (groupBy.get(a.groupId)?.sort ?? 0) - (groupBy.get(b.groupId)?.sort ?? 0) || a.sort - b.sort || a.name.localeCompare(b.name));
  for (const c of sortedCats) {
    if (c.kind === "internal_rta") continue;
    const cm = mr.categories[c.id] ?? ZERO_CM(c.id);
    const pc = buildCategory(c, cm, cacheBy.get(c.id), tmap.get(c.id), month, notes.categories[c.id] ?? null, cleared);
    if (c.kind === "uncategorized") {
      if (pc.available !== 0n || pc.activity !== 0n) uncategorized = pc;
      continue;
    }
    if (c.deletedAt) continue;
    const g = groupBy.get(c.groupId);
    if (!g || g.deletedAt) continue;
    if (c.hidden || g.hidden) {
      hidden.push(pc);
      continue;
    }
    let pg = planGroups.get(g.id);
    if (!pg) {
      pg = {
        id: g.id,
        name: g.name,
        sort: g.sort,
        hidden: g.hidden,
        isSystem: g.isSystem,
        isCreditCardPayments: false,
        assigned: 0n,
        activity: 0n,
        available: 0n,
        categories: [],
      };
      planGroups.set(g.id, pg);
    }
    if (c.kind === "cc_payment") pg.isCreditCardPayments = true;
    pg.categories.push(pc);
    pg.assigned += pc.assigned;
    pg.activity += pc.activity;
    pg.available += pc.available;
  }
  const orderedGroups = [...planGroups.values()].sort((a, b) => Number(b.isCreditCardPayments) - Number(a.isCreditCardPayments) || a.sort - b.sort);

  // month totals over every category (hidden and deleted included: they are in the math)
  let leftOver = 0n;
  let assigned = 0n;
  let activity = 0n;
  let available = 0n;
  for (const cm of Object.values(mr.categories)) {
    leftOver += cm.carryIn;
    assigned += cm.assigned;
    activity += cm.activity;
    available += cm.available;
  }
  const s = summaryRows[0];
  const readyToAssign = s ? s.rtaMilli : mr.readyToAssignDisplay;
  return {
    month,
    label: formatMonth(month),
    engineVersion: ENGINE_VERSION,
    fromCache,
    groups: orderedGroups,
    hidden,
    uncategorized,
    summary: {
      readyToAssign,
      rtaRaw: mr.rta,
      rtaState: readyToAssign > 0n ? "positive" : readyToAssign < 0n ? "negative" : "zero",
      assignedInFuture: s ? s.assignedFutureMilli : mr.assignedInFuture,
      leftOverFromLastMonth: leftOver,
      rtaLeftOverFromLastMonth: mr.leftOverFromLastMonth,
      income: mr.income,
      inflowFromDebtAccounts: mr.inflowFromDebtAccounts,
      cashOverspendingLastMonth: mr.cashOverspendingLastMonth,
      cashOverspending: mr.cashOverspending,
      assigned,
      activity,
      available,
      costToBeMe: s ? s.costToBeMeMilli : mr.costToBeMe,
      underfunded: mr.underfunded,
      ageOfMoney: s ? s.ageOfMoney : mr.ageOfMoney,
    },
    monthNote: notes.month,
    range: { first, last },
  };
}

// ── categoryDetail ──────────────────────────────────────────────────────────

export interface CategoryDetail {
  month: Month;
  category: PlanCategory;
  groupName: string;
  /** Available breakdown for the category sheet (§12.1). */
  breakdown: {
    leftOverFromLastMonth: Milli;
    assigned: Milli;
    cashSpending: Milli;
    creditSpending: Milli;
    /** Inflows/refunds, and for payment categories the funded-spending/payment moves. */
    otherActivity: Milli;
    available: Milli;
  };
  /** Assigned/activity/available for the previous 12 months (for the sheet's history chart). */
  history: { month: Month; assigned: Milli; activity: Milli; available: Milli }[];
  recentTransactions: TransactionRow[];
}

export async function categoryDetail(db: DbLike, month: Month, categoryId: string, opts: { today?: ISODate; limit?: number } = {}): Promise<CategoryDetail> {
  const today = opts.today ?? localToday();
  const [cat] = await db.select().from(categories).where(eq(categories.id, categoryId));
  if (!cat) throw new NotFoundError("category", categoryId);
  const [grp] = await db.select().from(categoryGroups).where(eq(categoryGroups.id, cat.groupId));
  const { result, mr, fromCache } = await resultFor(db, month, today);
  const cm = mr.categories[cat.id] ?? ZERO_CM(cat.id);
  const [cacheRow] = fromCache
    ? await db
        .select()
        .from(budgetMonthCache)
        .where(and(eq(budgetMonthCache.engineVersion, ENGINE_VERSION), eq(budgetMonthCache.month, month), eq(budgetMonthCache.categoryId, cat.id)))
    : [];
  const tmap = await effectiveTargets(db, month, [cat.id]);
  const notes = await getMonthNotes(db, month);
  const cleared = await clearedBalances(db, cat.linkedAccountId ? [cat.linkedAccountId] : []);
  const pc = buildCategory(cat, cm, cacheRow, tmap.get(cat.id), month, notes.categories[cat.id] ?? null, cleared);
  const history = result.monthList
    .filter((m) => m < month)
    .slice(-12)
    .map((m) => {
      const h = result.months[m]!.categories[cat.id];
      return { month: m, assigned: h?.assigned ?? 0n, activity: h?.activity ?? 0n, available: h?.available ?? 0n };
    });
  const recent = await listTransactions(db, { categoryIds: [cat.id] }, { limit: opts.limit ?? 20 });
  return {
    month,
    category: pc,
    groupName: grp?.name ?? "",
    breakdown: {
      leftOverFromLastMonth: pc.carryIn,
      assigned: pc.assigned,
      cashSpending: pc.cashSpending,
      creditSpending: pc.creditSpending,
      otherActivity: pc.activity - pc.cashSpending - pc.creditSpending,
      available: pc.available,
    },
    history,
    recentTransactions: recent.rows,
  };
}
