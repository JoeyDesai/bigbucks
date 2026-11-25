import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accounts, assets, balances } from "@homebase/db";
import { parseMilli } from "@homebase/shared";
import { buildSchedule, levelPayment, parseRate } from "../src/wealth/amortization";
import { holdings, investmentGrowth } from "../src/wealth/investments";
import { balancesAt, netWorth, sampleDates } from "../src/wealth/netWorth";
import { homeDetail, mortgageDetail, setHomeValue } from "../src/wealth/property";
import { accountsBySection } from "../src/wealth/sections";
import { getOverview } from "../src/overview";
import { spendingSummary } from "../src/reports";
import { TODAY, useDemoDb } from "./helpers";

const env = useDemoDb();
const $ = parseMilli;

async function acct(name: string) {
  const [a] = await env.db.select().from(accounts).where(eq(accounts.name, name));
  return a!;
}

/** Independent check: Σ latest balance ≤ date over household accounts, split by sign. */
async function directNetWorth(date: string) {
  const r = await env.db.execute<{ assets: bigint; liabilities: bigint; nw: bigint }>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (b.account_id) b.account_id, b.current_milli
      FROM balances b JOIN accounts a ON a.id = b.account_id JOIN entities e ON e.id = a.entity_id
      WHERE b.as_of <= ${date} AND e.name = 'Household' AND a.deleted_at IS NULL
      ORDER BY b.account_id, b.as_of DESC
    )
    SELECT coalesce(sum(greatest(current_milli, 0)), 0)::bigint AS assets, coalesce(-sum(least(current_milli, 0)), 0)::bigint AS liabilities, coalesce(sum(current_milli), 0)::bigint AS nw FROM latest`);
  const row = r.rows[0]!;
  return { assets: BigInt(row.assets), liabilities: BigInt(row.liabilities), nw: BigInt(row.nw) };
}

describe("netWorth", () => {
  it("series sums balances correctly (household only by default)", async () => {
    const res = await netWorth(env.db, { period: "1Y", today: TODAY });
    expect(res.granularity).toBe("month");
    expect(res.series.length).toBeGreaterThan(10);
    expect(res.series.at(-1)!.date).toBe(TODAY);
    for (const p of res.series) {
      const d = await directNetWorth(p.date);
      expect([p.assets, p.liabilities, p.netWorth]).toEqual([d.assets, d.liabilities, d.nw]);
      expect(Object.values(p.byKind).reduce((s, x) => s + x, 0n)).toBe(p.netWorth);
    }
    // agrees with the reporting view for the household entity
    const v = await env.db.execute<{ nw: bigint }>(sql`SELECT net_worth_milli AS nw FROM v_net_worth_daily WHERE date = ${TODAY} AND entity_name = 'Household'`);
    expect(res.headline.netWorth).toBe(BigInt(v.rows[0]!.nw));
    const prev = await directNetWorth("2026-09-30");
    expect(res.headline.lastMonthEnd).toBe("2026-09-30");
    expect(res.headline.changeVsLastMonth).toBe(res.headline.netWorth - prev.nw);
  });

  it("includes the business only when asked", async () => {
    const a = await netWorth(env.db, { period: "1M", today: TODAY });
    const b = await netWorth(env.db, { period: "1M", today: TODAY, includeBusiness: true });
    const mercury = await acct("Mercury Checking");
    const [m] = await balancesAt(env.db, [TODAY], { includeBusiness: true, accountIds: [mercury.id] });
    expect(b.headline.netWorth - a.headline.netWorth).toBe(m!.balance);
    expect(a.series).toHaveLength(31);
  });

  it("samples weeks and months", () => {
    expect(sampleDates("2026-01-01", "2026-03-15", "month")).toEqual(["2026-01-01", "2026-01-31", "2026-02-28", "2026-03-15"]);
    const w = sampleDates("2026-10-01", "2026-10-22", "week");
    expect(w).toEqual(["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22"]);
  });
});

describe("accounts by section", () => {
  it("groups household accounts per §12.3 and hides the business by default", async () => {
    const { sections, businessAvailable } = await accountsBySection(env.db, { today: TODAY });
    expect(businessAvailable).toBe(true);
    expect(sections.map((s) => s.key)).toEqual(["cash", "credit", "investments", "retirement", "crypto", "home", "mortgage"]);
    const home = sections.find((s) => s.key === "home")!.accounts[0]!;
    expect(home.home!.equity).toBe(home.home!.value! - home.home!.mortgageBalance);
    const mort = sections.find((s) => s.key === "mortgage")!.accounts[0]!;
    expect(mort.mortgage!.payoffDate).toBeTruthy();
    for (const s of sections) expect(s.total).toBe(s.accounts.reduce((x, a) => x + a.balance, 0n));
    const withR = await accountsBySection(env.db, { today: TODAY, includeBusiness: true });
    expect(withR.sections.at(-1)!.key).toBe("business");
  });
});

describe("holdings and growth", () => {
  it("sums the latest snapshot per symbol", async () => {
    const h = await holdings(env.db);
    const v = await env.db.execute<{ total: bigint }>(sql`SELECT sum(market_value_milli)::bigint AS total FROM v_holdings_latest WHERE entity_name = 'Household'`);
    expect(h.total).toBe(BigInt(v.rows[0]!.total));
    const btc = h.positions.find((p) => p.symbol === "BTC")!;
    expect(btc.accounts).toHaveLength(2);
    expect(btc.quantity).toMatch(/^0\.297/);
    expect(btc.assetClass).toBe("crypto");
    expect(h.positions.reduce((s, p) => s + p.weightBps, 0)).toBeLessThanOrEqual(10_000);
    const k = await acct("Litware 401k (Alex)");
    const one = await holdings(env.db, { accountId: k.id });
    expect(one.positions).toHaveLength(1); // two lots of FDEEX summed
    expect(one.positions[0]!.accounts).toHaveLength(1);
  });

  it("splits growth into contributions and market change", async () => {
    const k = await acct("Litware 401k (Alex)");
    const g = await investmentGrowth(env.db, k.id, 6, { today: TODAY });
    expect(g.months).toHaveLength(6);
    expect(g.months.at(-1)!.partial).toBe(true);
    for (const m of g.months) {
      expect(m.contributions + m.marketChange).toBe(m.change);
      expect(m.change).toBe(m.end - m.start);
      expect(m.label).toBe("market change");
    }
    expect(g.months[0]!.contributions).toBe($("1100"));
    const [startBal] = await balancesAt(env.db, ["2026-04-30"], { accountIds: [k.id] });
    expect(g.months[0]!.start).toBe(startBal!.balance);
    const coinbase = await acct("Coinbase");
    const c = await investmentGrowth(env.db, coinbase.id, 3, { today: TODAY });
    expect(c.months[0]!.label).toBe("market change + unknown contributions");
  });
});

describe("home and mortgage", () => {
  it("mortgage schedule matches the seeded balances and simulates extra payments", async () => {
    const m = await acct("Mortgage");
    const d = await mortgageDetail(env.db, m.id, { today: TODAY, scenario: { extraMonthly: $("200") } });
    const [b] = await env.db.execute<{ c: bigint }>(sql`SELECT current_milli AS c FROM balances WHERE account_id = ${m.id} AND as_of = ${TODAY}`).then((r) => r.rows);
    expect(d.scheduledBalance).toBe(-BigInt(b!.c));
    expect(d.syncedBalance).toBeNull(); // only amortization snapshots in the demo
    expect(d.driftFlagged).toBe(false);
    expect(levelPayment($("308000"), parseRate("0.065"), 360)).toBe($("1946.77"));
    expect(d.payoffDate! < "2053-07-01").toBe(true); // the $3k extra principal pulls payoff in
    expect(d.nextPayment!.date).toBe("2026-11-01");
    expect(d.nextPayment!.total).toBe(d.nextPayment!.principal + d.nextPayment!.interest + $("520"));
    expect(d.scenario!.interestSaved).toBeGreaterThan(0n);
    expect(d.scenario!.monthsSaved).toBeGreaterThan(0);
    expect(d.principalPaidToDate + d.scheduledBalance).toBe($("308000"));
    const recast = await mortgageDetail(env.db, m.id, { today: TODAY, scenario: { recast: { date: "2026-11-15", lumpSum: $("20000") } } });
    expect(recast.scenario!.newPayment!).toBeLessThan($("1946.77"));
    // a statement-balance correction resets the balance
    const s = buildSchedule({ principal: $("1000"), annualRate: "0", termMonths: 10, firstPaymentDate: "2026-01-01", payment: $("100"), escrow: 0n }, [{ date: "2026-03-15", kind: "statement_balance", amount: $("500"), newPayment: null, newRate: null }]);
    expect(s.rows.length).toBe(8);
    expect(s.totalInterest).toBe(0n);
  });

  it("home detail: equity = value − mortgage; manual override wins", async () => {
    const h = await homeDetail(env.db, { today: TODAY });
    expect(h.latest).not.toBeNull();
    expect(h.equity).toBe(h.latest!.value - h.mortgageBalance);
    expect(h.valuations.length).toBeGreaterThan(10);
    expect(h.equitySeries.every((e) => e.equity === e.value - e.mortgage)).toBe(true);
    const [asset] = await env.db.select().from(assets);
    await setHomeValue(env.ctx, { assetId: asset!.id, value: $("450000"), asOf: TODAY });
    const h2 = await homeDetail(env.db, { today: TODAY });
    expect(h2.latest!.value).toBe($("450000"));
    const [bal] = await env.db.select().from(balances).where(sql`${balances.accountId} = ${asset!.accountId} AND ${balances.asOf} = ${TODAY}`);
    expect(bal!.currentMilli).toBe($("450000"));
    await env.reseed();
  });
});

describe("overview and spending", () => {
  it("get_overview", async () => {
    const o = await getOverview(env.db, { today: TODAY });
    expect(o.readyToAssign).toBe($("412.18"));
    expect(o.overspent.map((c) => c.name).sort()).toEqual(["Uncategorized", "Eating Out", "Misc"].sort());
    expect(o.unapprovedCount).toBeGreaterThan(0);
    expect(o.netWorth).toBe((await netWorth(env.db, { today: TODAY })).headline.netWorth);
  });

  it("spending summary by group adds up", async () => {
    const byCat = await spendingSummary(env.db, { groupBy: "category", from: "2026-09-01", to: "2026-09-30" });
    const byGroup = await spendingSummary(env.db, { groupBy: "group", from: "2026-09-01", to: "2026-09-30" });
    expect(byCat.total).toBe(byGroup.total);
    expect(byCat.total).toBeGreaterThan(0n);
    const cf = await env.db.execute<{ e: bigint }>(sql`SELECT expense_milli AS e FROM v_cashflow_monthly WHERE month = '2026-09-01'`);
    expect(byCat.total).toBe(BigInt(cf.rows[0]!.e));
  });
});
