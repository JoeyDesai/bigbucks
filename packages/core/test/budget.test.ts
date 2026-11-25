import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { budgetMonthCache, budgetMonthSummary, categories, transactions } from "@homebase/db";
import { ENGINE_VERSION, computeBudget } from "@homebase/engine";
import { parseMilli } from "@homebase/shared";
import { assign } from "../src/budget/operations";
import { ensureFresh, recompute } from "../src/budget/cache";
import { loadSnapshot } from "../src/budget/snapshot";
import { getBudgetMonth, categoryDetail } from "../src/budget/view";
import { MONTH, TODAY, useDemoDb } from "./helpers";

const env = useDemoDb();
const $ = parseMilli;

async function catId(name: string): Promise<string> {
  const [c] = await env.db.select({ id: categories.id }).from(categories).where(eq(categories.name, name));
  return c!.id;
}

describe("recompute", () => {
  it("writes exactly what a direct engine run computes", async () => {
    await recompute(env.db, { today: TODAY });
    const snapshot = await loadSnapshot(env.db);
    const direct = computeBudget(snapshot, { through: MONTH > "2026-11-01" ? MONTH : "2026-11-01", asOf: TODAY });
    const rows = await env.db.select().from(budgetMonthCache).where(eq(budgetMonthCache.engineVersion, ENGINE_VERSION));
    const sums = await env.db.select().from(budgetMonthSummary).where(eq(budgetMonthSummary.engineVersion, ENGINE_VERSION));
    // assign-ahead into Nov 2026 extends the range past the current month
    expect(direct.monthList[direct.monthList.length - 1]).toBe("2026-11-01");
    expect(sums.map((s) => s.month).sort()).toEqual(direct.monthList);
    const known = new Set(snapshot.categories.map((c) => c.id));
    let expected = 0;
    for (const m of direct.monthList) {
      const mr = direct.months[m]!;
      const s = sums.find((x) => x.month === m)!;
      expect(s.rtaMilli).toBe(mr.readyToAssignDisplay);
      expect(s.assignedFutureMilli).toBe(mr.assignedInFuture);
      expect(s.costToBeMeMilli).toBe(mr.costToBeMe);
      expect(s.ageOfMoney).toBe(mr.ageOfMoney);
      for (const cm of Object.values(mr.categories)) {
        if (!known.has(cm.categoryId)) continue;
        expected++;
        const r = rows.find((x) => x.month === m && x.categoryId === cm.categoryId);
        expect(r, `${m} ${cm.categoryId}`).toBeDefined();
        expect([r!.assignedMilli, r!.activityMilli, r!.availableMilli, r!.carryInMilli, r!.cashOverspendMilli, r!.creditOverspendMilli, r!.neededMilli, r!.underfundedMilli]).toEqual([
          cm.assigned,
          cm.activity,
          cm.available,
          cm.carryIn,
          cm.cashOverspend,
          cm.creditOverspend,
          cm.needed,
          cm.underfunded,
        ]);
      }
    }
    expect(rows).toHaveLength(expected);
  });

  it("rewrites only from the earliest changed month", async () => {
    await recompute(env.db, { today: TODAY });
    const before = await env.db.select({ month: budgetMonthCache.month, categoryId: budgetMonthCache.categoryId, createdAt: budgetMonthCache.createdAt }).from(budgetMonthCache);
    const groceries = await catId("Groceries");
    const r = await assign(env.ctx, { month: "2026-09-01", categoryId: groceries, expr: "+10" });
    expect(r.recomputedFrom).toBe("2026-09-01");
    const after = await env.db.select({ month: budgetMonthCache.month, categoryId: budgetMonthCache.categoryId, createdAt: budgetMonthCache.createdAt }).from(budgetMonthCache);
    const key = (x: { month: string; categoryId: string }) => `${x.month}|${x.categoryId}`;
    const prev = new Map(before.map((b) => [key(b), b.createdAt.getTime()]));
    let untouched = 0;
    let rewritten = 0;
    for (const a of after) {
      const old = prev.get(key(a));
      if (a.month < "2026-09-01") {
        expect(a.createdAt.getTime()).toBe(old);
        untouched++;
      } else {
        expect(a.createdAt.getTime()).not.toBe(old);
        rewritten++;
      }
    }
    expect(untouched).toBeGreaterThan(0);
    expect(rewritten).toBeGreaterThan(0);
    // September's groceries reflect the change, and carry flows into October
    const [sep] = await env.db.select().from(budgetMonthCache).where(and(eq(budgetMonthCache.month, "2026-09-01"), eq(budgetMonthCache.categoryId, groceries)));
    const [oct] = await env.db.select().from(budgetMonthCache).where(and(eq(budgetMonthCache.month, "2026-10-01"), eq(budgetMonthCache.categoryId, groceries)));
    expect(oct!.carryInMilli).toBe(sep!.availableMilli > 0n ? sep!.availableMilli : 0n);
    await env.reseed();
  });

  it("detects writes made outside core and recomputes", async () => {
    await recompute(env.db, { today: TODAY });
    const fresh = await ensureFresh(env.db, TODAY);
    expect(fresh.recomputed).toBe(false);
    const groceries = await catId("Groceries");
    const [checking] = await env.db.execute<{ id: string }>(sql`SELECT id FROM accounts WHERE name = 'Checking'`).then((r) => r.rows);
    const view0 = await getBudgetMonth(env.db, MONTH, { today: TODAY });
    const g0 = view0.groups.flatMap((g) => g.categories).find((c) => c.id === groceries)!;
    await env.db.insert(transactions).values({ accountId: checking!.id, date: "2026-10-20", amountMilli: -$("12.34"), categoryId: groceries, cleared: "cleared", approved: true, source: "manual" });
    const stale = await ensureFresh(env.db, TODAY);
    expect(stale.recomputed).toBe(true);
    const view1 = await getBudgetMonth(env.db, MONTH, { today: TODAY });
    const g1 = view1.groups.flatMap((g) => g.categories).find((c) => c.id === groceries)!;
    expect(g1.activity - g0.activity).toBe(-$("12.34"));
    expect(g1.available - g0.available).toBe(-$("12.34"));
    await env.reseed();
  });
});

describe("getBudgetMonth", () => {
  it("returns the Plan screen for October 2026 (demo facts)", async () => {
    const v = await getBudgetMonth(env.db, MONTH, { today: TODAY });
    expect(v.fromCache).toBe(true);
    expect(v.groups[0]!.isCreditCardPayments).toBe(true);
    expect(v.groups[0]!.name).toBe("Credit Card Payments");
    expect(v.groups.some((g) => g.name === "Internal Master Category")).toBe(false);
    // seed: $412.18 left unassigned, $290 assigned ahead into November
    expect(v.summary.readyToAssign).toBe($("412.18"));
    expect(v.summary.assignedInFuture).toBe($("290"));
    expect(v.summary.rtaRaw).toBe($("702.18"));
    expect(v.summary.rtaState).toBe("positive");
    // the panel adds up
    expect(v.summary.leftOverFromLastMonth + v.summary.assigned + v.summary.activity).toBe(v.summary.available);
    const all = v.groups.flatMap((g) => g.categories);
    const misc = all.find((c) => c.name === "Misc")!;
    expect(misc.available).toBe(-$("137.42"));
    expect(misc.creditOverspend).toBe($("137.42"));
    expect(misc.pill).toBe("yellow");
    expect(misc.monthNote).toMatch(/Fence repair/);
    expect(all.find((c) => c.name === "Eating Out")!.available).toBe(-$("64.18"));
    expect(v.uncategorized?.available).toBe(-$("426.50"));
    expect(v.hidden.map((c) => c.name)).toContain("House Costs");
    expect(v.monthNote).toBe("Car registration due in November.");
    const giving = all.find((c) => c.name === "Giving")!;
    expect(giving.target?.amount).toBe($("500"));
    expect(giving.target?.effectiveFrom).toBe("2026-01-01");
    const card = v.groups[0]!.categories.find((c) => c.name === "Cash Back Card")!;
    expect(card.payment).not.toBeNull();
    expect(card.payment!.suggestedPayment).toBeGreaterThanOrEqual(0n);
    for (const g of v.groups) expect(g.available).toBe(g.categories.reduce((s, c) => s + c.available, 0n));
  });

  it("computes months outside the cached range on the fly", async () => {
    const v = await getBudgetMonth(env.db, "2027-01-01", { today: TODAY });
    expect(v.fromCache).toBe(false);
    expect(v.summary.assigned).toBe(0n);
  });

  it("categoryDetail breaks Available down", async () => {
    const misc = await catId("Misc");
    const d = await categoryDetail(env.db, MONTH, misc, { today: TODAY });
    const b = d.breakdown;
    expect(b.leftOverFromLastMonth + b.assigned + b.cashSpending + b.creditSpending + b.otherActivity).toBe(b.available);
    expect(b.available).toBe(-$("137.42"));
    expect(d.recentTransactions.length).toBeGreaterThan(0);
    expect(d.history.length).toBe(12);
  });
});
