/**
 * §13 reports against the demo seed. Every total is checked against an independent SQL sum over
 * v_transactions_flat / v_cashflow_monthly / v_net_worth_daily, or against the engine's numbers.
 *
 * Runs on its own database `<TEST_DATABASE_URL name>_core_reports_test` (default
 * homebase_core_reports_test), migrated and demo-seeded here, so it never races the other core suites.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, runMigrations, type Db } from "@homebase/db";
import { DEMO_TODAY, seedDemo } from "../../db/src/seed/demo";
import { clearBudgetMemo, ensureFresh } from "../src/budget/cache";
import { userCtx } from "../src/context";
import { listSavedReports, saveReport } from "../src/reports";
import {
  ageOfMoneyReport,
  budgetCategories,
  budgetPerformanceReport,
  cashFlowSankeyReport,
  categoryDetailReport,
  drillDown,
  HUB,
  incomeVsExpenseReport,
  investmentGrowthReport,
  milliToDecimal,
  netWorthReport,
  paramsFromSearch,
  paramsToSearch,
  parseSavedSpec,
  payeesReport,
  reportParams,
  resolvePeriod,
  runReport,
  runSavedReport,
  savedReportsIndex,
  saveReportView,
  setSavedReportPinned,
  spendingBreakdownReport,
  spendingTrendsReport,
  subscriptionsReport,
  toCsv,
  type ReportParamsInput,
} from "../src/reports/index";
import { listTransactions } from "../src/transactions/list";
import { investmentGrowth } from "../src/wealth/investments";
import { ensureDatabase } from "./db";

const TODAY = DEMO_TODAY; // 2026-10-22
const OCT = "2026-10-01";

function reportsTestUrl(): string {
  const base = new URL(process.env.TEST_DATABASE_URL ?? "postgres://homebase@localhost:54329/homebase_test");
  const name = base.pathname.slice(1);
  if (!name.endsWith("_test")) throw new Error(`refusing to use ${name}: test database names must end in _test`);
  base.pathname = `/${name.replace(/_test$/, "_core_reports_test")}`;
  if (!base.pathname.endsWith("_test")) throw new Error("refusing a non-_test database");
  return base.toString();
}

let db: Db;
let pool: { end(): Promise<void> };
let alexId: string;

beforeAll(async () => {
  const url = reportsTestUrl();
  await ensureDatabase(url);
  const admin = createDb(url, { max: 1 });
  await admin.pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await admin.pool.end();
  await runMigrations(url);
  const c = createDb(url, { max: 4 });
  db = c.db;
  pool = c.pool;
  await seedDemo(db, { force: true });
  clearBudgetMemo();
  const [alex] = await db.query.users.findMany({ where: (u, { eq }) => eq(u.displayName, "Alex") });
  alexId = alex!.id;
  await ensureFresh(db, TODAY);
});

afterAll(async () => {
  await pool?.end();
});

const P = (p: ReportParamsInput = {}) => reportParams({ today: TODAY, ...p });

/** Independent household spending sum for [from, to] (the YNAB Reflect rule, written out by hand). */
async function sqlSpending(from: string, to: string, extra = sql`TRUE`): Promise<bigint> {
  const r = await db.execute<{ s: bigint | null }>(sql`
    SELECT -sum(amount_milli) AS s FROM v_transactions_flat
    WHERE on_budget AND NOT is_starting_balance AND cleared <> 'pending'
      AND (category_kind IS NULL OR category_kind <> 'internal_rta')
      AND NOT (transfer_account_id IS NOT NULL AND category_id IS NULL)
      AND date BETWEEN ${from} AND ${to} AND ${extra}`);
  return BigInt(r.rows[0]?.s ?? 0n);
}

/** −Σ engine activity of spending categories (normal + uncategorized, plus amounts categorized directly to card payment categories). */
async function engineSpending(month: string): Promise<{ total: bigint; byCategory: Map<string, bigint> }> {
  const { result } = await ensureFresh(db, TODAY);
  const cats = await budgetCategories(db);
  const kind = new Map(cats.map((c) => [c.id, c.kind]));
  const byCategory = new Map<string, bigint>();
  let total = 0n;
  for (const [id, cm] of Object.entries(result.months[month]!.categories)) {
    const k = kind.get(id);
    const v = k === "normal" || k === "uncategorized" ? -cm.activity : k === "cc_payment" ? -(cm.payment?.direct ?? 0n) : 0n;
    if (v !== 0n) byCategory.set(id, v);
    total += v;
  }
  return { total, byCategory };
}

describe("params and periods", () => {
  it("resolves month, quarter, YTD, last 12 and custom", () => {
    expect(resolvePeriod(P({ period: "month" }))).toMatchObject({ from: OCT, to: TODAY, months: [OCT], days: 22, label: "October 2026" });
    expect(resolvePeriod(P({ period: "month", month: "2026-09-01" }))).toMatchObject({ from: "2026-09-01", to: "2026-09-30", days: 30 });
    expect(resolvePeriod(P({ period: "quarter" }))).toMatchObject({ from: OCT, to: TODAY, label: "Q4 2026" });
    expect(resolvePeriod(P({ period: "quarter", month: "2026-08-01" }))).toMatchObject({ from: "2026-07-01", to: "2026-09-30" });
    expect(resolvePeriod(P({ period: "ytd" }))).toMatchObject({ from: "2026-01-01", to: TODAY });
    const l12 = resolvePeriod(P({ period: "last12" }));
    expect(l12.from).toBe("2025-11-01");
    expect(l12.months).toHaveLength(12);
    expect(resolvePeriod(P({ period: "custom", from: "2026-03-05", to: "2026-04-10" }))).toMatchObject({ months: ["2026-03-01", "2026-04-01"], days: 37 });
    expect(() => resolvePeriod(P({ period: "custom", from: "2026-05-01", to: "2026-04-01" }))).toThrow();
  });

  it("round-trips URL params and ignores junk", () => {
    const p = paramsFromSearch({ period: "custom", from: "2026-01-01", to: "2026-02-28", entity: "all", level: "group", accounts: "not-a-uuid" });
    expect(p).toMatchObject({ period: "custom", from: "2026-01-01", to: "2026-02-28", entity: "all", level: "group" });
    expect(p.accountIds).toBeUndefined();
    expect(paramsFromSearch(paramsToSearch(p))).toEqual(p);
    const d = { period: "last12" as const, level: "group" as const };
    const m = paramsFromSearch({ period: "month", level: "category" }, d);
    expect(paramsToSearch(m, d).toString()).toBe("period=month&level=category");
    expect(paramsFromSearch(paramsToSearch(m, d), d)).toEqual(m);
    expect(paramsFromSearch({ period: "bogus", m: "2026-09" }, { period: "last12" })).toMatchObject({ period: "last12", month: "2026-09-01" });
    expect(paramsFromSearch({ period: "custom" }).period).toBe("month"); // custom without a start falls back
  });
});

describe("spending breakdown (report 1)", () => {
  it("Oct 2026 total reconciles with v_transactions_flat, v_cashflow_monthly and engine activity", async () => {
    const r = await spendingBreakdownReport(db, P());
    const flat = await sqlSpending(OCT, TODAY);
    const cf = await db.execute<{ e: bigint }>(sql`SELECT expense_milli AS e FROM v_cashflow_monthly WHERE month = ${OCT}`);
    const eng = await engineSpending(OCT);
    expect(r.total).toBe(flat);
    expect(r.total).toBe(BigInt(cf.rows[0]!.e));
    expect(r.total).toBe(eng.total);
    expect(r.total).toBeGreaterThan(0n);
    // every category row equals that category's engine activity
    for (const row of r.rows) {
      expect(row.drill.categoryIds).toHaveLength(1);
      expect(row.amount).toBe(eng.byCategory.get(row.drill.categoryIds![0]!) ?? 0n);
    }
    expect(r.rows.reduce((t, x) => t + x.amount, 0n)).toBe(r.total);
    expect(r.table.total!.amount).toBe(r.total);
  });

  it("averages, most frequent, largest outflow, donut", async () => {
    const r = await spendingBreakdownReport(db, P());
    expect(r.avgMonthly).toBe(r.total);
    expect(r.avgDaily).toBe((r.total * 2n + 22n) / 44n); // divRound(total, 22)
    const big = await db.execute<{ a: bigint }>(sql`
      SELECT min(amount_milli) AS a FROM v_transactions_flat
      WHERE on_budget AND NOT is_starting_balance AND cleared <> 'pending' AND (category_kind IS NULL OR category_kind <> 'internal_rta')
        AND NOT (transfer_account_id IS NOT NULL AND category_id IS NULL) AND date BETWEEN ${OCT} AND ${TODAY}`);
    expect(r.largestOutflow!.amount).toBe(-BigInt(big.rows[0]!.a));
    const maxOut = Math.max(...r.rows.map((x) => x.outflows));
    expect(r.mostFrequent!.outflows).toBe(maxOut);
    expect(r.donut.length).toBeLessThanOrEqual(8);
    expect(r.donut.reduce((t, d) => t + d.amount, 0n)).toBe(r.rows.filter((x) => x.amount > 0n).reduce((t, x) => t + x.amount, 0n));
    const shares = r.rows.reduce((t, x) => t + x.shareBps, 0);
    expect(Math.abs(shares - 10_000)).toBeLessThanOrEqual(r.rows.length);
  });

  it("group level sums its categories; account filter narrows to one card", async () => {
    const cat = await spendingBreakdownReport(db, P());
    const grp = await spendingBreakdownReport(db, P({ level: "group" }));
    expect(grp.total).toBe(cat.total);
    const bills = grp.rows.find((x) => x.label === "Bills")!;
    expect(bills.amount).toBe(cat.rows.filter((x) => x.groupLabel === "Bills").reduce((t, x) => t + x.amount, 0n));
    const [disc] = (await db.execute<{ id: string }>(sql`SELECT id FROM accounts WHERE name = 'Cash Back Card'`)).rows;
    const one = await spendingBreakdownReport(db, P({ accountIds: [disc!.id] }));
    expect(one.total).toBe(await sqlSpending(OCT, TODAY, sql`account_id = ${disc!.id}`));
    expect(one.total).toBeLessThan(cat.total);
  });

  it("Business: non-transfer outflows of the business accounts, bucketed by payee", async () => {
    const r = await spendingBreakdownReport(db, P({ entity: "business", period: "last12" }));
    const s = await db.execute<{ s: bigint }>(sql`
      SELECT -sum(amount_milli) AS s FROM v_transactions_flat
      WHERE entity_name <> 'Household' AND NOT is_transfer AND amount_milli < 0 AND cleared <> 'pending' AND NOT is_starting_balance AND date BETWEEN '2025-11-01' AND ${TODAY}`);
    expect(r.total).toBe(BigInt(s.rows[0]!.s));
    expect(r.rows.every((x) => x.key.startsWith("payee:") || x.key.startsWith("category:"))).toBe(true);
    const all = await spendingBreakdownReport(db, P({ entity: "all", period: "last12" }));
    const hh = await spendingBreakdownReport(db, P({ period: "last12" }));
    expect(all.total).toBe(hh.total + r.total);
  });

  it("drill-down filters list exactly the category's transactions", async () => {
    const r = await spendingBreakdownReport(db, P());
    const gas = r.rows.find((x) => x.label.includes("Gas"))!;
    const d = drillDown("spending-breakdown", gas.drill, { period: r.period });
    expect(d.query).toMatchObject({ category: gas.drill.categoryIds![0], from: OCT, to: TODAY });
    expect(d.href).toMatch(/^\/activity\?category=[0-9a-f-]+&from=2026-10-01&to=2026-10-22$/);
    const page = await listTransactions(db, d.filters, { limit: 500 });
    let net = 0n;
    for (const t of page.rows) {
      expect(t.date >= OCT && t.date <= TODAY).toBe(true);
      if (t.cleared === "pending") continue;
      net += t.isSplit ? t.splits.filter((s) => s.categoryId === gas.drill.categoryIds![0]).reduce((a, s) => a + s.amount, 0n) : t.amount;
    }
    expect(-net).toBe(gas.amount);
    expect(drillDown("x", "category:abc|month:2026-02-01", { period: r.period }).query).toMatchObject({ category: "abc", from: "2026-02-01", to: "2026-02-28" });
  });
});

describe("spending trends (report 2)", () => {
  it("each month equals v_cashflow_monthly expense; stacks add up; average", async () => {
    const r = await spendingTrendsReport(db, P({ period: "last12", level: "group" }));
    const cf = await db.execute<{ month: string; e: bigint }>(sql`SELECT month::text AS month, expense_milli AS e FROM v_cashflow_monthly WHERE month >= '2025-11-01'`);
    const by = new Map(cf.rows.map((x) => [x.month, BigInt(x.e)]));
    expect(r.months).toHaveLength(12);
    for (const m of r.months) {
      expect(m.total).toBe(by.get(m.month) ?? 0n);
      expect(Object.values(m.values).reduce((t, v) => t + v, 0n)).toBe(m.total);
    }
    expect(r.total).toBe(await sqlSpending("2025-11-01", TODAY));
    expect(r.average).toBe((r.total * 2n + 12n) / 24n);
    expect(r.series.reduce((t, s) => t + s.amount, 0n)).toBe(r.total);
    expect(r.table.rows.reduce((t, x) => t + (x.cells.amount as bigint), 0n)).toBe(r.total);
  });
});

describe("income vs expense (report 3)", () => {
  it("matches v_cashflow_monthly month by month, with the savings rate", async () => {
    const r = await incomeVsExpenseReport(db, P({ period: "last12" }));
    const cf = await db.execute<{ month: string; i: bigint; e: bigint; rate: string | null }>(sql`
      SELECT month::text AS month, income_milli AS i, expense_milli AS e, savings_rate::text AS rate FROM v_cashflow_monthly WHERE month >= '2025-11-01'`);
    const by = new Map(cf.rows.map((x) => [x.month, x]));
    for (const m of r.months) {
      const v = by.get(m.month)!;
      expect(m.income).toBe(BigInt(v.i));
      expect(m.expense).toBe(BigInt(v.e));
      expect(m.net).toBe(m.income - m.expense);
      if (v.rate !== null) expect(Math.abs(m.savingsRateBps! - Math.round(Number(v.rate) * 10_000))).toBeLessThanOrEqual(1);
    }
    expect(r.totals.income).toBe(r.months.reduce((t, m) => t + m.income, 0n));
    expect(r.sources.reduce((t, s) => t + s.amount, 0n)).toBe(r.totals.income);
  });
});

describe("net worth (report 4)", () => {
  it("end point equals v_net_worth_daily for the household", async () => {
    const r = await netWorthReport(db, P({ period: "last12" }));
    expect(r.granularity).toBe("month");
    const v = await db.execute<{ a: bigint; l: bigint; n: bigint }>(sql`
      SELECT assets_milli AS a, liabilities_milli AS l, net_worth_milli AS n FROM v_net_worth_daily WHERE date = ${TODAY} AND entity_name = 'Household'`);
    expect(r.end).toMatchObject({ date: TODAY, assets: BigInt(v.rows[0]!.a), liabilities: BigInt(v.rows[0]!.l), netWorth: BigInt(v.rows[0]!.n) });
    expect(r.change).toBe(r.end.netWorth - r.start.netWorth);
    expect(r.accounts.reduce((t, a) => t + a.end, 0n)).toBe(r.end.netWorth);
    for (const p of r.points) expect(p.netWorth).toBe(p.assets + p.liabilities);
  });
});

describe("age of money (report 5)", () => {
  it("is the engine's month-end Age of Money (= v_month_summary)", async () => {
    const r = await ageOfMoneyReport(db, P({ period: "last12" }));
    const v = await db.execute<{ month: string; aom: number | null }>(sql`SELECT month::text AS month, age_of_money AS aom FROM v_month_summary WHERE month BETWEEN '2025-11-01' AND ${OCT}`);
    const by = new Map(v.rows.map((x) => [x.month, x.aom === null ? null : Number(x.aom)]));
    expect(r.months).toHaveLength(12);
    for (const m of r.months) expect(m.days).toBe(by.get(m.month));
    expect(r.current).not.toBeNull();
  });
});

describe("category detail (report 6)", () => {
  it("assigned and spent per month equal v_month_category; target months counted", async () => {
    const [g] = (await db.execute<{ id: string }>(sql`SELECT id FROM categories WHERE name = 'Groceries'`)).rows;
    const r = await categoryDetailReport(db, P({ period: "last12", categoryId: g!.id }));
    const v = await db.execute<{ month: string; a: bigint; act: bigint; u: bigint; n: bigint; t: string | null }>(sql`
      SELECT month::text AS month, assigned_milli AS a, activity_milli AS act, underfunded_milli AS u, needed_milli AS n, target_type::text AS t
      FROM v_month_category WHERE category_id = ${g!.id} AND month BETWEEN '2025-11-01' AND ${OCT}`);
    const by = new Map(v.rows.map((x) => [x.month, x]));
    for (const m of r.months) {
      const x = by.get(m.month)!;
      expect(m.assigned).toBe(BigInt(x.a));
      expect(m.spent).toBe(-BigInt(x.act));
    }
    expect(r.totalSpent).toBe(await sqlSpending("2025-11-01", TODAY, sql`category_id = ${g!.id}`));
    const met = v.rows.filter((x) => BigInt(x.n) > 0n && BigInt(x.u) === 0n && x.t !== null).length;
    expect(r.monthsMetTarget).toBe(met);
    expect(r.subject?.name).toBe("Groceries");
    // default subject = the biggest spender; group level works too
    const def = await categoryDetailReport(db, P({ period: "last12" }));
    expect(def.subject).not.toBeNull();
    const grp = await categoryDetailReport(db, P({ period: "last12", level: "group" }));
    expect(grp.subject?.level).toBe("group");
    expect(grp.subject!.categoryIds.length).toBeGreaterThan(1);
  });
});

describe("payees (report 7)", () => {
  it("payee spend sums to the spending total; frequency ranking", async () => {
    const r = await payeesReport(db, P({ period: "last12" }), { limit: 1000 });
    expect(r.bySpend.reduce((t, p) => t + p.amount, 0n)).toBe(r.total);
    expect(r.total).toBe(await sqlSpending("2025-11-01", TODAY));
    const top = r.bySpend[0]!;
    expect(top.amount).toBe(await sqlSpending("2025-11-01", TODAY, sql`payee_id = ${top.payeeId}`));
    for (let i = 1; i < r.byFrequency.length; i++) expect(r.byFrequency[i - 1]!.transactions).toBeGreaterThanOrEqual(r.byFrequency[i]!.transactions);
    expect(r.trend.series.length).toBeLessThanOrEqual(5);
    const t0 = r.trend.series[0]!.key;
    expect(r.trend.months.reduce((t, m) => t + (m.values[t0] ?? 0n), 0n)).toBe(top.payeeId && `payee:${top.payeeId}` === t0 ? top.amount : r.bySpend.find((p) => p.key === t0)!.amount);
  });
});

describe("cash-flow sankey (report 8)", () => {
  it("balances at the hub: income sources in, groups (+ kept) out", async () => {
    const r = await cashFlowSankeyReport(db, P({ month: "2026-09-01" }));
    const into = r.links.filter((l) => l.target === HUB).reduce((t, l) => t + l.value, 0n);
    const out = r.links.filter((l) => l.source === HUB).reduce((t, l) => t + l.value, 0n);
    expect(into).toBe(out);
    const inc = await db.execute<{ i: bigint }>(sql`SELECT income_milli AS i FROM v_cashflow_monthly WHERE month = '2026-09-01'`);
    expect(r.income).toBe(BigInt(inc.rows[0]!.i));
    const names = r.nodes.map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
    for (const l of r.links) {
      expect(names).toContain(l.source);
      expect(names).toContain(l.target);
      expect(l.value).toBeGreaterThan(0n);
    }
    // each group's outflow equals its categories' inflows
    for (const g of r.nodes.filter((n) => n.kind === "group")) {
      const gin = r.links.filter((l) => l.target === g.name).reduce((t, l) => t + l.value, 0n);
      const gout = r.links.filter((l) => l.source === g.name).reduce((t, l) => t + l.value, 0n);
      if (gout > 0n) expect(gout).toBe(gin);
    }
  });
});

describe("investment growth (report 9)", () => {
  it("sums the per-account core numbers; contributions + market = change", async () => {
    const r = await investmentGrowthReport(db, P({ period: "last12" }));
    expect(r.accounts.length).toBeGreaterThan(0);
    expect(r.months).toHaveLength(12);
    for (const m of r.months) expect(m.contributions + m.marketChange).toBe(m.change);
    let change = 0n;
    for (const a of r.accounts) change += (await investmentGrowth(db, a.accountId, 12, { today: TODAY })).totals.change;
    expect(r.totals.change).toBe(change);
    const k401 = r.accounts.find((a) => a.name.includes("401k (Alex)"))!;
    // completed months carry the manual $1,100 monthly contribution
    expect(k401.months.filter((m) => !m.partial).every((m) => m.contributions >= 1_100_000n)).toBe(true);
  });
});

describe("budget performance (report 10)", () => {
  it("counts overspent months from the engine and suggests whole dollars", async () => {
    const r = await budgetPerformanceReport(db, P({ period: "last12" }));
    expect(r.months).toHaveLength(11); // the in-progress month is left out
    const v = await db.execute<{ category_id: string; n: number; over_plan: number }>(sql`
      SELECT category_id::text, count(*) FILTER (WHERE available_milli < 0)::int AS n,
        count(*) FILTER (WHERE -activity_milli > assigned_milli AND activity_milli < 0)::int AS over_plan FROM v_month_category
      WHERE month BETWEEN '2025-11-01' AND '2026-09-01' AND category_kind = 'normal' GROUP BY 1`);
    const by = new Map(v.rows.map((x) => [x.category_id, Number(x.n)]));
    const plan = new Map(v.rows.map((x) => [x.category_id, Number(x.over_plan)]));
    expect(r.rows.some((x) => x.monthsOverAssigned > 0)).toBe(true);
    for (const row of r.rows) {
      expect(row.monthsOverspent).toBe(by.get(row.categoryIds[0]!) ?? 0);
      expect(row.monthsOverAssigned).toBe(plan.get(row.categoryIds[0]!) ?? 0);
      expect(row.suggested % 1000n).toBe(0n);
      expect(row.suggested).toBeGreaterThanOrEqual(row.avgSpent);
    }
  });
});

describe("subscriptions (report 11)", () => {
  it("finds the streaming subscriptions and their price increases", async () => {
    const r = await subscriptionsReport(db, P({ period: "last12" }));
    const spotify = r.rows.find((x) => x.payee === "Spotify")!;
    expect(spotify).toMatchObject({ cadence: "monthly", amount: 19_990n, annualized: 239_880n, active: true });
    expect(spotify.priceChange).toMatchObject({ from: 16_990n, to: 19_990n, changedOn: expect.stringMatching(/^2026-07/) });
    expect(r.priceIncreases.map((x) => x.payee)).toEqual(expect.arrayContaining(["Spotify", "Netflix"]));
    expect(r.totals.annualized).toBe(r.active.reduce((t, x) => t + x.annualized, 0n));
    // a month view still detects them (history is not limited to the period) but reports no increase in Oct
    const oct = await subscriptionsReport(db, P());
    expect(oct.rows.some((x) => x.payee === "Spotify")).toBe(true);
    expect(oct.priceIncreases.find((x) => x.payee === "Spotify")).toBeUndefined();
  });
});

describe("saved reports (report 12)", () => {
  it("parses the seed's query spec, Ask chart specs and report references; pins", async () => {
    const ctx = userCtx(db, alexId, TODAY);
    const seeded = (await listSavedReports(db))[0]!;
    expect(parseSavedSpec(seeded.spec).kind).toBe("query");
    const run = await runSavedReport(db, seeded.id);
    const years = run.chart!.series![0]!.data;
    expect(years.map((d) => d.x)).toEqual(["2025", "2026"]);
    const [eo] = (await db.execute<{ id: string }>(sql`SELECT id FROM categories WHERE name = 'Eating Out'`)).rows;
    const s2026 = await sqlSpending("2026-01-01", "2026-12-31", sql`category_id = ${eo!.id}`);
    expect(years[1]!.y).toBeCloseTo(Number(milliToDecimal(s2026)), 2);

    const chart = await saveReport(ctx, { name: "Pie", spec: { type: "pie", title: "Pie", format: "currency", series: [{ name: "s", data: [{ x: "a", y: 1 }] }] } });
    expect((await runSavedReport(db, chart.id)).parsed.kind).toBe("chart");
    const ref = await saveReportView(ctx, { name: "Groups 12 mo", report: "spending-trends", params: { period: "last12", level: "group", today: "2026-01-01" } });
    const parsed = parseSavedSpec(ref.spec);
    expect(parsed).toEqual({ kind: "report", report: "spending-trends", params: { period: "last12", level: "group" } });
    const data = await runReport(db, "spending-trends", { ...(parsed.kind === "report" ? parsed.params : {}), today: TODAY });
    expect(data.months).toHaveLength(12);
    await setSavedReportPinned(ctx, ref.id, true);
    const idx = await savedReportsIndex(db);
    expect(idx.filter((x) => x.pinned).map((x) => x.name)).toEqual(expect.arrayContaining(["Groups 12 mo"]));
    expect(idx[0]!.pinned).toBe(true);
    expect(parseSavedSpec({ nope: 1 }).kind).toBe("invalid");
  });
});

describe("CSV", () => {
  it("formats money, percent and escapes", async () => {
    expect(milliToDecimal(-1_234_565n)).toBe("-1234.57");
    expect(milliToDecimal(4n)).toBe("0.00");
    expect(milliToDecimal(-4n)).toBe("0.00");
    expect(toCsv([{ a: 'He said "hi", ok', b: 1_500n, c: null }])).toBe('a,b,c\r\n"He said ""hi"", ok",1.50,\r\n');
    // Formula injection: text cells that start with = + - @ \t \r get a leading ', numeric cells don't.
    expect(
      toCsv([
        { payee: "=HYPERLINK(\"http://evil\",\"x\")", memo: "+1+cmd|' /C calc'!A0", amt: -1_234_560n, n: -5 },
        { payee: "-2+3", memo: "@SUM(A1)", amt: 0n, n: 0 },
        { payee: "\tTAB", memo: "\rCR", amt: 5n, n: 1 },
        { payee: "Kroger", memo: "a=b", amt: -10n, n: -1 },
        { payee: "-12.50", memo: "-", amt: null, n: null },
      ]),
    ).toBe(
      [
        "payee,memo,amt,n",
        `"'=HYPERLINK(""http://evil"",""x"")",'+1+cmd|' /C calc'!A0,-1234.56,-5`,
        "'-2+3,'@SUM(A1),0.00,0",
        `'\tTAB,"'\rCR",0.01,1`,
        "Kroger,a=b,-0.01,-1",
        "-12.50,'-,,",
      ].join("\r\n") + "\r\n",
    );
    const r = await spendingBreakdownReport(db, P());
    const csv = toCsv(r.table);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("Category,Group,Outflows,Share,Spent");
    expect(lines).toHaveLength(r.rows.length + 2);
    expect(lines[lines.length - 1]).toBe(`Total,,${r.rows.reduce((t, x) => t + x.outflows, 0)},100.00,${milliToDecimal(r.total)}`);
  });

  it("every report runs and has a table", async () => {
    for (const slug of ["spending-breakdown", "spending-trends", "income-vs-expense", "net-worth", "age-of-money", "category-detail", "payees", "cash-flow", "investment-growth", "budget-performance", "subscriptions"] as const) {
      const r = await runReport(db, slug, { today: TODAY, period: "last12" });
      expect(r.table.rows.length, slug).toBeGreaterThan(0);
      expect(toCsv(r.table).length).toBeGreaterThan(10);
    }
  });
});
