import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accounts, balances, categories } from "@homebase/db";
import { addDays, parseMilli } from "@homebase/shared";
import { bucketBar, bucketTotals, monthPace, monthlyGoalAmount, ratio } from "../src/buckets/math";
import { getBucketMonth, spentByCategory } from "../src/buckets/month";
import { accountBalanceHistory, budgetAccountsBalanceHistory, buildDailyBalances } from "../src/buckets/history";
import { listAccounts } from "../src/transactions/accounts";
import { MONTH, TODAY, useDemoDb } from "./helpers";

const $ = parseMilli;

describe("bucket math (pure)", () => {
  it("bar = remaining share; over budget fills red, capped", () => {
    expect(bucketBar($("100"), $("25"))).toMatchObject({ state: "under", fill: 0.75, over: 0, remaining: $("75") });
    expect(bucketBar($("100"), $("90"))).toMatchObject({ state: "warn", fill: 0.1 });
    expect(bucketBar($("100"), $("100"))).toMatchObject({ state: "warn", fill: 0, over: 0, remaining: 0n });
    expect(bucketBar($("100"), $("130"))).toMatchObject({ state: "over", fill: 0, over: 0.3, remaining: $("-30") });
    expect(bucketBar($("100"), $("450"))).toMatchObject({ state: "over", over: 1 });
    // refunds can make spent negative: the bar stays full
    expect(bucketBar($("100"), $("-20"))).toMatchObject({ state: "under", fill: 1, remaining: $("120") });
    expect(bucketBar(null, $("40"))).toMatchObject({ state: "none", fill: 0, over: 0 });
    expect(bucketBar(0n, $("40")).state).toBe("none");
  });

  it("monthly goal amounts per target type and cadence", () => {
    const base = { cadence: "monthly" as const, cadenceEvery: 1, day: null };
    expect(monthlyGoalAmount({ ...base, type: "need_set_aside", amount: $("480") }, MONTH)).toEqual({ amount: $("480"), kind: "monthly" });
    expect(monthlyGoalAmount({ ...base, type: "need_refill", amount: $("240") }, MONTH)?.amount).toBe($("240"));
    expect(monthlyGoalAmount({ ...base, type: "monthly_builder", amount: $("300") }, MONTH)?.amount).toBe($("300"));
    expect(monthlyGoalAmount({ ...base, type: "debt", amount: $("150") }, MONTH)?.amount).toBe($("150"));
    expect(monthlyGoalAmount({ type: "need_set_aside", amount: $("1140"), cadence: "every_n_months", cadenceEvery: 6, day: null }, MONTH)?.amount).toBe($("190"));
    expect(monthlyGoalAmount({ type: "need_set_aside", amount: $("130"), cadence: "yearly", cadenceEvery: 1, day: null }, MONTH)?.amount).toBe($("10.83"));
    // Oct 2026 has five Thursdays
    expect(monthlyGoalAmount({ type: "need_set_aside", amount: $("20"), cadence: "weekly", cadenceEvery: 1, day: 4 }, MONTH)?.amount).toBe($("100"));
    expect(monthlyGoalAmount({ type: "balance_by_date", amount: $("20000"), cadence: "none", cadenceEvery: 1, day: null }, MONTH)).toEqual({ amount: $("20000"), kind: "balance" });
    expect(monthlyGoalAmount({ ...base, type: "percent_of_income", amount: 0n }, MONTH)).toBeNull();
    expect(monthlyGoalAmount({ ...base, type: "percent_of_income", amount: 0n }, MONTH, { percentNeeded: $("812.50") })?.amount).toBe($("812.50"));
    expect(monthlyGoalAmount({ ...base, type: "monthly_builder", amount: 0n }, MONTH)).toBeNull();
  });

  it("pace compares spending with the share of the month gone", () => {
    const p = monthPace(MONTH, TODAY, $("1000"), $("900"));
    expect(p.daysInMonth).toBe(31);
    expect(p.daysLeft).toBe(10); // Oct 22 … 31
    expect(p.elapsed).toBeCloseTo(22 / 31, 4);
    expect(p.status).toBe("ahead");
    expect(monthPace(MONTH, TODAY, $("1000"), $("700")).status).toBe("on_pace");
    expect(monthPace(MONTH, TODAY, $("1000"), $("300")).status).toBe("behind");
    expect(monthPace("2026-09-01", TODAY, $("1000"), $("300"))).toMatchObject({ elapsed: 1, daysLeft: 0 });
    expect(monthPace("2026-11-01", TODAY, $("1000"), 0n)).toMatchObject({ elapsed: 0, daysLeft: 30, status: "none" });
  });

  it("totals leave savings goals and goal-less spending out of the monthly budget", () => {
    const t = bucketTotals([
      { budget: $("100"), spent: $("40"), kind: "monthly" },
      { budget: $("20000"), spent: 0n, kind: "balance" },
      { budget: null, spent: $("15"), kind: null },
    ]);
    expect(t).toEqual({ budget: $("100"), spent: $("55"), budgetedSpent: $("40"), left: $("60"), unbudgetedSpent: $("15") });
    expect(ratio(1n, 3n)).toBeCloseTo(0.3333, 4);
  });

  it("daily balances: ledger only, then snapshots with walks back and forward", () => {
    const nets = new Map([
      ["2026-01-01", $("100")],
      ["2026-01-03", $("-30")],
      ["2026-01-05", $("10")],
    ]);
    const ledger = buildDailyBalances(nets, new Map(), "2025-12-31", "2026-01-05").map((p) => p.balanceMilli);
    expect(ledger).toEqual([0n, $("100"), $("100"), $("70"), $("70"), $("80")]);
    // the bank says 500 on Jan 4: earlier days walk back from it, later days walk forward
    const snap = buildDailyBalances(nets, new Map([["2026-01-04", $("500")]]), "2026-01-01", "2026-01-06").map((p) => p.balanceMilli);
    expect(snap).toEqual([$("530"), $("530"), $("500"), $("500"), $("510"), $("510")]);
  });
});

const env = useDemoDb();

async function acct(name: string) {
  const [a] = await env.db.select().from(accounts).where(eq(accounts.name, name));
  return a!;
}

describe("getBucketMonth (demo)", () => {
  it("rows are visible normal categories with their goals; spent matches the ledger", async () => {
    const m = await getBucketMonth(env.db, MONTH, { today: TODAY });
    const rows = m.groups.flatMap((g) => g.rows);
    expect(rows.length).toBeGreaterThan(20);
    const cats = await env.db.select().from(categories);
    const kind = new Map(cats.map((c) => [c.id, c]));
    for (const r of rows) {
      expect(kind.get(r.id)!.kind).toBe("normal");
      expect(kind.get(r.id)!.hidden).toBe(false);
    }
    expect(rows.some((r) => /^(Cash Back Card|Rewards Card)$|ready to assign|inflow/i.test(r.name))).toBe(false);
    const groceries = rows.find((r) => r.name === "Groceries")!;
    expect(groceries.budget).toBe($("950"));
    const direct = await env.db.execute<{ s: bigint }>(sql`
      SELECT coalesce(-sum(t.amount_milli), 0)::bigint AS s FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE t.category_id = ${groceries.id} AND t.deleted_at IS NULL AND a.on_budget AND t.cleared <> 'pending' AND NOT t.is_split
        AND t.date BETWEEN '2026-10-01' AND '2026-10-31'`);
    const splits = await env.db.execute<{ s: bigint }>(sql`
      SELECT coalesce(-sum(s.amount_milli), 0)::bigint AS s FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id
      WHERE s.category_id = ${groceries.id} AND t.deleted_at IS NULL AND t.cleared <> 'pending' AND t.date BETWEEN '2026-10-01' AND '2026-10-31'`);
    expect(groceries.spent).toBe(BigInt(direct.rows[0]!.s) + BigInt(splits.rows[0]!.s));
    expect(groceries.remaining).toBe(groceries.budget! - groceries.spent);
    // Emergency Fund is a balance goal: in its group total, not in the month's budget
    const emergency = rows.find((r) => r.name === "Emergency Fund");
    if (emergency) expect(emergency.goal?.kind).toBe("balance");
    const monthly = rows.filter((r) => r.goal?.kind === "monthly");
    expect(m.totals.budget).toBe(monthly.reduce((a, r) => a + r.budget!, 0n));
    expect(m.totals.spent).toBe(rows.reduce((a, r) => a + r.spent, 0n));
    expect(m.totals.left).toBe(m.totals.budget - monthly.reduce((a, r) => a + r.spent, 0n));
    for (const g of m.groups) expect(g.spent).toBe(g.rows.reduce((a, r) => a + r.spent, 0n));
    expect(m.pace.daysLeft).toBe(10);
  });

  it("uncategorized spending is reported separately; pending is left out", async () => {
    const m = await getBucketMonth(env.db, MONTH, { today: TODAY });
    expect(m.uncategorized.count).toBeGreaterThan(0);
    expect(m.uncategorized.spent).toBeGreaterThan(0n);
    const gas = m.groups.flatMap((g) => g.rows).find((r) => r.name === "Gas")!;
    const all = await spentByCategory(env.db, MONTH);
    expect(all.get(gas.id)?.spent).toBe(gas.spent);
    // the demo's pending $41.87 Shell swipe is not in Gas
    const withPending = await env.db.execute<{ s: bigint }>(sql`
      SELECT coalesce(-sum(t.amount_milli), 0)::bigint AS s FROM transactions t
      WHERE t.category_id = ${gas.id} AND t.deleted_at IS NULL AND t.date BETWEEN '2026-10-01' AND '2026-10-31'`);
    expect(BigInt(withPending.rows[0]!.s) - gas.spent).toBe($("41.87"));
  });
});

describe("accountBalanceHistory (demo)", () => {
  it("ledger accounts: one point per day, ending at the working balance, matching snapshots", async () => {
    const checking = await acct("Checking");
    const hist = await accountBalanceHistory(env.db, checking.id, { today: TODAY });
    expect(hist[0]!.date).toBe("2025-05-01");
    expect(hist[hist.length - 1]!.date).toBe(TODAY);
    for (let i = 1; i < hist.length; i++) expect(hist[i]!.date).toBe(addDays(hist[i - 1]!.date, 1));
    const [summary] = await listAccounts(env.db, { ids: [checking.id], today: TODAY });
    expect(hist[hist.length - 1]!.balanceMilli).toBe(summary!.workingBalance);
    const snaps = await env.db.select().from(balances).where(eq(balances.accountId, checking.id));
    const byDay = new Map(hist.map((p) => [p.date, p.balanceMilli]));
    for (const s of snaps.slice(0, 50)) expect(byDay.get(s.asOf)).toBe(s.currentMilli);
  });

  it("from/to clip the series; tracking accounts follow their snapshots", async () => {
    const brokerage = await acct("Litware Brokerage");
    const hist = await accountBalanceHistory(env.db, brokerage.id, { from: "2026-09-01", to: "2026-09-30" });
    expect(hist).toHaveLength(30);
    const snaps = await env.db.select().from(balances).where(eq(balances.accountId, brokerage.id));
    const snap = new Map(snaps.map((s) => [s.asOf, s.currentMilli]));
    for (const p of hist) if (snap.has(p.date)) expect(p.balanceMilli).toBe(snap.get(p.date));
  });

  it("budget accounts total = Σ open on-budget accounts", async () => {
    const total = await budgetAccountsBalanceHistory(env.db, { from: "2026-10-01", today: TODAY });
    expect(total).toHaveLength(22);
    const budget = (await listAccounts(env.db, { today: TODAY })).filter((a) => a.onBudget);
    let sum = 0n;
    for (const a of budget) {
      const h = await accountBalanceHistory(env.db, a.id, { from: "2026-10-01", today: TODAY });
      sum += h[h.length - 1]!.balanceMilli;
    }
    expect(total[total.length - 1]!.balanceMilli).toBe(sum);
  });
});
