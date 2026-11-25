/**
 * §13 Reports. Every report takes the common `ReportParams` (period, accounts, entity, level), returns
 * bigint-milli data plus a `table` (the list under the chart and the CSV export), and every table row
 * can drill into transactions (`drillDown`).
 */
import type { DbLike } from "../context";
import { ageOfMoneyReport, budgetPerformanceReport, categoryDetailReport } from "./budget";
import { cashFlowSankeyReport, incomeVsExpenseReport } from "./cashflow";
import { reportParams, type ReportLevel, type ReportParams, type ReportParamsInput, type ReportSlug } from "./params";
import { payeesReport, spendingBreakdownReport, spendingTrendsReport } from "./spending";
import { subscriptionsReport } from "./subscriptions";
import type { ReportTable } from "./table";
import { investmentGrowthReport, netWorthReport } from "./wealth";

export * from "./params";
export * from "./table";
export { reportScope, type Scope } from "./scope";
export * from "./spending";
export * from "./cashflow";
export * from "./budget";
export * from "./wealth";
export * from "./subscriptions";
export * from "./saved";

export interface ReportMeta {
  slug: ReportSlug;
  title: string;
  blurb: string;
  /** Period the report opens with. */
  defaultPeriod: ReportParams["period"];
  /** Level the report opens with. */
  defaultLevel: ReportLevel;
  /** Which common filters apply. */
  filters: { level: boolean; accounts: boolean; entity: boolean };
}

export const REPORTS: readonly ReportMeta[] = [
  { slug: "spending-breakdown", title: "Spending breakdown", blurb: "Where the money went, by category or group.", defaultPeriod: "month", defaultLevel: "category", filters: { level: true, accounts: true, entity: true } },
  { slug: "spending-trends", title: "Spending trends", blurb: "Month by month, stacked, against the average.", defaultPeriod: "last12", defaultLevel: "group", filters: { level: true, accounts: true, entity: true } },
  { slug: "income-vs-expense", title: "Income vs expense", blurb: "What came in, what went out, and the savings rate.", defaultPeriod: "last12", defaultLevel: "category", filters: { level: false, accounts: true, entity: true } },
  { slug: "net-worth", title: "Net worth", blurb: "Assets less liabilities, over time.", defaultPeriod: "last12", defaultLevel: "category", filters: { level: false, accounts: true, entity: true } },
  { slug: "age-of-money", title: "Age of Money", blurb: "How many days old a dollar is when you spend it.", defaultPeriod: "last12", defaultLevel: "category", filters: { level: false, accounts: false, entity: false } },
  { slug: "category-detail", title: "Category detail", blurb: "Assigned against spent for one category, and how often it met its target.", defaultPeriod: "last12", defaultLevel: "category", filters: { level: true, accounts: false, entity: false } },
  { slug: "payees", title: "Payees", blurb: "Who gets paid most, and most often.", defaultPeriod: "last12", defaultLevel: "category", filters: { level: false, accounts: true, entity: true } },
  { slug: "cash-flow", title: "Cash flow", blurb: "Income sources flowing into groups and categories.", defaultPeriod: "last12", defaultLevel: "category", filters: { level: true, accounts: true, entity: true } },
  { slug: "investment-growth", title: "Investment growth", blurb: "Contributions against market change, by month.", defaultPeriod: "last12", defaultLevel: "category", filters: { level: false, accounts: true, entity: true } },
  { slug: "budget-performance", title: "Budget performance", blurb: "Which categories run over, by how much, and what to assign.", defaultPeriod: "last12", defaultLevel: "category", filters: { level: true, accounts: false, entity: false } },
  { slug: "subscriptions", title: "Subscriptions", blurb: "Recurring charges, what they cost a year, and price changes.", defaultPeriod: "last12", defaultLevel: "category", filters: { level: false, accounts: true, entity: true } },
  { slug: "saved", title: "Saved reports", blurb: "Views you saved here or from Ask.", defaultPeriod: "month", defaultLevel: "category", filters: { level: false, accounts: false, entity: false } },
];

export function reportMeta(slug: string): ReportMeta | undefined {
  return REPORTS.find((r) => r.slug === slug);
}

/** The URL defaults of a report (for `paramsFromSearch` / `paramsToSearch`). */
export function reportDefaults(slug: string): Pick<ReportParams, "period" | "level"> {
  const m = reportMeta(slug);
  return { period: m?.defaultPeriod ?? "month", level: m?.defaultLevel ?? "category" };
}

export interface ReportResultMap {
  "spending-breakdown": Awaited<ReturnType<typeof spendingBreakdownReport>>;
  "spending-trends": Awaited<ReturnType<typeof spendingTrendsReport>>;
  "income-vs-expense": Awaited<ReturnType<typeof incomeVsExpenseReport>>;
  "net-worth": Awaited<ReturnType<typeof netWorthReport>>;
  "age-of-money": Awaited<ReturnType<typeof ageOfMoneyReport>>;
  "category-detail": Awaited<ReturnType<typeof categoryDetailReport>>;
  payees: Awaited<ReturnType<typeof payeesReport>>;
  "cash-flow": Awaited<ReturnType<typeof cashFlowSankeyReport>>;
  "investment-growth": Awaited<ReturnType<typeof investmentGrowthReport>>;
  "budget-performance": Awaited<ReturnType<typeof budgetPerformanceReport>>;
  subscriptions: Awaited<ReturnType<typeof subscriptionsReport>>;
}
export type RunnableReport = keyof ReportResultMap;

const RUNNERS: { [K in RunnableReport]: (db: DbLike, p: ReportParams) => Promise<ReportResultMap[K]> } = {
  "spending-breakdown": spendingBreakdownReport,
  "spending-trends": spendingTrendsReport,
  "income-vs-expense": incomeVsExpenseReport,
  "net-worth": netWorthReport,
  "age-of-money": ageOfMoneyReport,
  "category-detail": categoryDetailReport,
  payees: (db, p) => payeesReport(db, p),
  "cash-flow": (db, p) => cashFlowSankeyReport(db, p),
  "investment-growth": investmentGrowthReport,
  "budget-performance": budgetPerformanceReport,
  subscriptions: subscriptionsReport,
};

export function isRunnableReport(slug: string): slug is RunnableReport {
  return slug in RUNNERS;
}

/** Run a report by slug. `params` is validated (and defaulted) with ReportParamsSchema. */
export async function runReport<K extends RunnableReport>(db: DbLike, slug: K, params: ReportParamsInput | ReportParams = {}): Promise<ReportResultMap[K]> {
  const p = reportParams(params);
  return RUNNERS[slug](db, p);
}

/** The table of any report result (for CSV export). */
export function reportTable(result: { table: ReportTable }): ReportTable {
  return result.table;
}
