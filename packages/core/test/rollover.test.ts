/** Buckets: overflow (rollover). Pure carry math, then setBucketRollover + getBucketMonth on the demo data. */
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, categories } from "@homebase/db";
import { addMonths, parseMilli, type Month } from "@homebase/shared";
import { goalInEffect, monthlyGoalFromHistory, rolloverCarryIn, rolloverSchedule, type GoalHistoryRow } from "../src/buckets/math";
import { getBucketMonth, rolloverCarries, spentByCategory, spentByCategoryMonth } from "../src/buckets/month";
import { setBucketRollover, undo } from "../src/budget/operations";
import { MONTH, useDemoDb } from "./helpers";

const $ = parseMilli;
const JUL = "2026-07-01";
const AUG = "2026-08-01";
const SEP = "2026-09-01";
const OCT = "2026-10-01";

/** goalFor / spentFor from plain maps. */
const fixed = (amount: bigint) => () => amount;
const spending = (m: Record<string, string>) => (month: Month) => (m[month] ? $(m[month]!) : 0n);
const on = (from: Month, opening = 0n) => ({ enabled: true, from, opening });

describe("rollover carry (pure)", () => {
  it("saves up month after month when nothing is spent", () => {
    const sched = rolloverSchedule({ from: JUL, opening: 0n, through: SEP, goalFor: fixed($("50")), spentFor: spending({}) });
    expect(sched.map((r) => [r.month, r.carryIn, r.budget, r.carryOut])).toEqual([
      [JUL, 0n, $("50"), $("50")],
      [AUG, $("50"), $("100"), $("100")],
      [SEP, $("100"), $("150"), $("150")],
    ]);
    expect(rolloverCarryIn(on(JUL), OCT, fixed($("50")), spending({}))).toBe($("150"));
  });

  it("partial spending carries the rest", () => {
    expect(rolloverCarryIn(on(JUL), SEP, fixed($("50")), spending({ [JUL]: "20", [AUG]: "10" }))).toBe($("70")); // 30 + (50+30−10)
  });

  it("spending it all resets the carry to 0", () => {
    const spent = spending({ [AUG]: "100" }); // Jul leaves 50, Aug's budget 100 is spent in full
    expect(rolloverCarryIn(on(JUL), SEP, fixed($("50")), spent)).toBe(0n);
    expect(rolloverCarryIn(on(JUL), OCT, fixed($("50")), spent)).toBe($("50"));
  });

  it("overspending never goes negative", () => {
    const spent = spending({ [JUL]: "80" }); // $30 over in July
    expect(rolloverCarryIn(on(JUL), AUG, fixed($("50")), spent)).toBe(0n);
    expect(rolloverCarryIn(on(JUL), SEP, fixed($("50")), spent)).toBe($("50"));
    // refunds (negative spent) leave more behind
    expect(rolloverCarryIn(on(JUL), AUG, fixed($("50")), spending({ [JUL]: "-10" }))).toBe($("60"));
  });

  it("the opening amount is carried into the first month", () => {
    expect(rolloverCarryIn(on(JUL, $("175")), JUL, fixed($("50")), spending({}))).toBe($("175"));
    expect(rolloverCarryIn(on(JUL, $("175")), AUG, fixed($("50")), spending({ [JUL]: "25" }))).toBe($("200"));
    expect(rolloverCarryIn(on(JUL, $("-40")), JUL, fixed($("50")), spending({}))).toBe(0n);
  });

  it("goal changes mid-way are respected per month", () => {
    const history: GoalHistoryRow[] = [
      { effectiveFrom: "2026-01-01", removed: false, type: "need_set_aside", amount: $("50"), cadence: "monthly", cadenceEvery: 1, day: null },
      { effectiveFrom: AUG, removed: false, type: "need_set_aside", amount: $("80"), cadence: "monthly", cadenceEvery: 1, day: null },
      { effectiveFrom: OCT, removed: true, type: "need_set_aside", amount: 0n, cadence: "monthly", cadenceEvery: 1, day: null },
    ];
    expect(goalInEffect(history, JUL)?.amount).toBe($("50"));
    expect(goalInEffect(history, SEP)?.amount).toBe($("80"));
    expect(goalInEffect(history, OCT)).toBeNull();
    expect(goalInEffect(history, "2025-12-01")).toBeNull();
    const goalFor = (m: Month) => monthlyGoalFromHistory(history, m);
    // Jul 50 → Aug 50+80 → Sep 130+80 = 210; Oct has no goal: the carry still counts, then drains
    expect(rolloverCarryIn(on(JUL), OCT, goalFor, spending({}))).toBe($("210"));
    expect(rolloverCarryIn(on(JUL), "2026-11-01", goalFor, spending({ [OCT]: "60" }))).toBe($("150"));
    // savings (balance) goals add nothing
    expect(monthlyGoalFromHistory([{ effectiveFrom: JUL, removed: false, type: "balance", amount: $("20000"), cadence: "none", cadenceEvery: 1, day: null }], AUG)).toBe(0n);
  });

  it("months before rollover_from, and buckets with rollover off, have no carry", () => {
    expect(rolloverCarryIn(on(SEP, $("100")), AUG, fixed($("50")), spending({}))).toBe(0n);
    expect(rolloverCarryIn(on(SEP, $("100")), JUL, fixed($("50")), spending({}))).toBe(0n);
    expect(rolloverCarryIn({ enabled: false, from: JUL, opening: $("100") }, OCT, fixed($("50")), spending({}))).toBe(0n);
    expect(rolloverCarryIn({ enabled: true, from: null, opening: 0n }, OCT, fixed($("50")), spending({}))).toBe(0n);
    expect(rolloverSchedule({ from: OCT, opening: 0n, through: SEP, goalFor: fixed(1n), spentFor: fixed(0n) })).toEqual([]);
  });

  it("walks three years quickly", () => {
    const t0 = performance.now();
    expect(rolloverCarryIn(on("2023-10-01"), OCT, fixed($("50")), spending({}))).toBe($("1800"));
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

const env = useDemoDb();

async function categoryId(name: string): Promise<string> {
  const [c] = await env.db.select().from(categories).where(eq(categories.name, name));
  return c!.id;
}

describe("setBucketRollover + getBucketMonth (demo)", () => {
  const row = async (month: Month, id: string) => (await getBucketMonth(env.db, month, { today: env.ctx.today })).groups.flatMap((g) => g.rows).find((r) => r.id === id)!;

  it("carries leftovers from rollover_from on, matching a month-by-month walk of the ledger", async () => {
    const id = await categoryId("Alex's Spending Money");
    const before = await row(MONTH, id);
    const totalsBefore = (await getBucketMonth(env.db, MONTH, { today: env.ctx.today })).totals;
    expect(before).toMatchObject({ rollover: false, carryIn: 0n, goalAmount: $("100"), budget: $("100") });

    const r = await setBucketRollover(env.ctx, id, { enabled: true, openingMilli: $("175"), fromMonth: JUL });
    expect(r.operationId).toBeTruthy();
    const [cat] = await env.db.select().from(categories).where(eq(categories.id, id));
    expect(cat).toMatchObject({ rollover: true, rolloverFrom: JUL, rolloverOpeningMilli: $("175") });
    const [audit] = await env.db.select().from(auditLog).where(and(eq(auditLog.action, "budget.enable_rollover"), eq(auditLog.entityId, id)));
    expect(audit).toBeTruthy();

    // expected carry, walked by hand from each month's own read model and ledger sum
    let carry = $("175");
    for (let m: Month = JUL; m < MONTH; m = addMonths(m, 1)) {
      const rm = await row(m, id);
      expect(rm.carryIn).toBe(carry);
      expect(rm.budget).toBe(rm.goalAmount! + carry);
      const spent = (await spentByCategory(env.db, m)).get(id)?.spent ?? 0n;
      expect(rm.spent).toBe(spent);
      carry = rm.budget! - spent > 0n ? rm.budget! - spent : 0n;
    }
    const oct = await row(MONTH, id);
    expect(oct).toMatchObject({ rollover: true, rolloverFrom: JUL, carryIn: carry, goalAmount: $("100"), budget: $("100") + carry });
    expect(oct.remaining).toBe(oct.budget! - oct.spent);
    expect(oct.bar.remaining).toBe(oct.remaining);

    // the month's totals include the carry
    const m = await getBucketMonth(env.db, MONTH, { today: env.ctx.today });
    const monthly = m.groups.flatMap((g) => g.rows).filter((x) => x.goal?.kind === "monthly");
    expect(m.totals.budget).toBe(monthly.reduce((a, x) => a + x.budget!, 0n));
    expect(m.totals.budget - totalsBefore.budget).toBe(carry);
    expect(m.totals.left - totalsBefore.left).toBe(carry);

    // months before rollover_from are untouched
    expect(await row("2026-06-01", id)).toMatchObject({ rollover: true, carryIn: 0n, budget: $("100") });
  });

  it("spent per category per month comes from one query and matches the single-month sum", async () => {
    const id = await categoryId("Groceries");
    const all = await spentByCategoryMonth(env.db, "2025-05-01", MONTH);
    for (const m of [JUL, AUG, SEP, MONTH] as Month[]) expect(all.get(id)?.get(m) ?? 0n).toBe((await spentByCategory(env.db, m)).get(id)?.spent ?? 0n);
    const only = await spentByCategoryMonth(env.db, JUL, SEP, [id]);
    expect([...only.keys()]).toEqual([id]);
  });

  it("turning it off keeps the history but stops the carry; undo turns it back on", async () => {
    const id = await categoryId("Alex's Spending Money");
    const on = await row(MONTH, id);
    expect(on.carryIn).toBeGreaterThan(0n);
    const off = await setBucketRollover(env.ctx, id, { enabled: false });
    const [cat] = await env.db.select().from(categories).where(eq(categories.id, id));
    expect(cat).toMatchObject({ rollover: false, rolloverFrom: JUL, rolloverOpeningMilli: $("175") });
    expect(await row(MONTH, id)).toMatchObject({ rollover: false, rolloverFrom: null, carryIn: 0n, budget: $("100") });
    expect((await rolloverCarries(env.db, MONTH)).has(id)).toBe(false);

    await undo(env.ctx, off.operationId!);
    expect((await row(MONTH, id)).carryIn).toBe(on.carryIn);
  });

  it("turning it on without a month starts this month with nothing carried", async () => {
    const id = await categoryId("Sam's Spending Money");
    await setBucketRollover(env.ctx, id, { enabled: true });
    const [cat] = await env.db.select().from(categories).where(eq(categories.id, id));
    expect(cat).toMatchObject({ rollover: true, rolloverFrom: MONTH, rolloverOpeningMilli: 0n });
    expect(await row(MONTH, id)).toMatchObject({ rollover: true, carryIn: 0n, budget: $("100") });
    // next month gets what's left of October
    const oct = await row(MONTH, id);
    const nov = await row("2026-11-01", id);
    expect(nov.carryIn).toBe(oct.remaining > 0n ? oct.remaining : 0n);
    // a second "on" with an opening keeps the month and sets the amount
    await setBucketRollover(env.ctx, id, { enabled: true, openingMilli: $("40") });
    expect(await row(MONTH, id)).toMatchObject({ rolloverFrom: MONTH, carryIn: $("40"), budget: $("140") });
  });

  it("rejects non-bucket categories and bad input", async () => {
    const rta = await env.db.execute<{ id: string }>(sql`SELECT id FROM categories WHERE kind = 'internal_rta'`);
    await expect(setBucketRollover(env.ctx, rta.rows[0]!.id, { enabled: true })).rejects.toThrow(/can't roll over/);
    const id = await categoryId("Groceries");
    await expect(setBucketRollover(env.ctx, id, { enabled: true, openingMilli: -1n })).rejects.toThrow();
    await expect(setBucketRollover(env.ctx, id, { enabled: true, fromMonth: "2026-10-15" })).rejects.toThrow();
  });
});
