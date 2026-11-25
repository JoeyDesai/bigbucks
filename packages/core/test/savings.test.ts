/** Buckets: savings buckets. Pure balance walk, then setSavingsBucket / addToSavings / undo through getBucketMonth on the demo data. */
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, categories, targets } from "@homebase/db";
import { addMonths, parseMilli, type Month } from "@homebase/shared";
import { bucketTotals, savingsChangeError, savingsMonth, savingsProgress, savingsSchedule } from "../src/buckets/math";
import { getBucketMonth, readyToSave, spentByCategoryMonth } from "../src/buckets/month";
import { savingsContributions, savingsMonths } from "../src/buckets/savings";
import { getBudgetMonth } from "../src/budget/view";
import { addToSavings, setBucketRollover, setSavingsBucket, setSavingsTarget, undo } from "../src/budget/operations";
import { MONTH, TODAY, useDemoDb } from "./helpers";

const $ = parseMilli;
const JUL = "2026-07-01";
const AUG = "2026-08-01";
const SEP = "2026-09-01";
const OCT = "2026-10-01";
const by = (m: Record<string, string>) => (month: Month) => (m[month] ? $(m[month]!) : 0n);
const none = () => 0n;

describe("savings balance (pure)", () => {
  it("carries the starting balance", () => {
    const s = savingsSchedule({ from: JUL, opening: $("500") }, SEP, none, none);
    expect(s.map((r) => [r.month, r.carryIn, r.balance])).toEqual([
      [JUL, $("500"), $("500")],
      [AUG, $("500"), $("500")],
      [SEP, $("500"), $("500")],
    ]);
    expect(savingsSchedule({ from: JUL, opening: $("-40") }, JUL, none, none)[0]!.balance).toBe(0n);
  });

  it("contributions add, take-outs (negative) subtract", () => {
    const s = savingsSchedule({ from: JUL, opening: $("500") }, SEP, by({ [JUL]: "100", [AUG]: "250", [SEP]: "-50" }), none);
    expect(s.map((r) => [r.contributed, r.balance])).toEqual([
      [$("100"), $("600")],
      [$("250"), $("850")],
      [$("-50"), $("800")],
    ]);
  });

  it("spending draws it down; refunds put money back", () => {
    const m = savingsMonth({ from: JUL, opening: $("1000") }, AUG, by({ [JUL]: "400", [AUG]: "400" }), by({ [JUL]: "1200", [AUG]: "-30" }));
    // Jul 1000 + 400 − 1200 = 200; Aug 200 + 400 + 30 = 630
    expect(m).toMatchObject({ started: true, carryIn: $("200"), contributed: $("400"), spent: $("-30"), balance: $("630"), carryOut: $("630") });
  });

  it("the balance never carries negative", () => {
    const s = savingsSchedule({ from: JUL, opening: $("100") }, SEP, by({ [AUG]: "50" }), by({ [JUL]: "300" }));
    expect(s.map((r) => [r.carryIn, r.balance, r.carryOut])).toEqual([
      [$("100"), $("-200"), 0n],
      [0n, $("50"), $("50")],
      [$("50"), $("50"), $("50")],
    ]);
  });

  it("months before the start don't count", () => {
    const contributed = by({ [JUL]: "999", [AUG]: "100" });
    const spent = by({ [JUL]: "5000" });
    expect(savingsMonth({ from: AUG, opening: $("10") }, JUL, contributed, spent)).toMatchObject({ started: false, carryIn: 0n, contributed: 0n, spent: 0n, balance: 0n });
    expect(savingsMonth({ from: AUG, opening: $("10") }, SEP, contributed, spent)).toMatchObject({ started: true, carryIn: $("110"), balance: $("110") });
    expect(savingsSchedule({ from: OCT, opening: 0n }, SEP, contributed, spent)).toEqual([]);
  });

  it("take-out validation and progress", () => {
    expect(savingsChangeError($("300"), $("-300"))).toBeNull();
    expect(savingsChangeError($("300"), $("-300.01"))).toMatch(/more than the balance/);
    expect(savingsChangeError($("-50"), $("-1"))).toMatch(/more than the balance/);
    expect(savingsChangeError(0n, $("25"))).toBeNull();
    expect(savingsChangeError($("10"), 0n)).toMatch(/zero/);
    expect(savingsProgress($("2400"), $("15000"))).toBe(0.16);
    expect(savingsProgress($("16000"), $("15000"))).toBe(1);
    expect(savingsProgress($("-10"), $("15000"))).toBe(0);
    expect(savingsProgress($("10"), null)).toBeNull();
  });

  it("walks ten years quickly", () => {
    const t0 = performance.now();
    expect(savingsMonth({ from: "2016-11-01", opening: 0n }, OCT, () => $("100"), none).balance).toBe($("12000"));
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

const env = useDemoDb();

async function categoryId(name: string): Promise<string> {
  const [c] = await env.db.select().from(categories).where(eq(categories.name, name));
  return c!.id;
}
const month = (m: Month = MONTH) => getBucketMonth(env.db, m, { today: env.ctx.today });
const spendingRow = async (id: string, m: Month = MONTH) => (await month(m)).groups.flatMap((g) => g.rows).find((r) => r.id === id);
const savingsRow = async (id: string, m: Month = MONTH) => (await month(m)).savings.rows.find((r) => r.id === id);

describe("setSavingsBucket + addToSavings + getBucketMonth (demo)", () => {
  it("turning a bucket into savings moves it out of the groups and the summary", async () => {
    const id = await categoryId("Taxes");
    const before = await month();
    const row = before.groups.flatMap((g) => g.rows).find((r) => r.id === id)!;
    expect(row).toMatchObject({ bucketKind: "spending", savings: null, goalAmount: $("400") });
    const group = before.groups.find((g) => g.id === row.groupId)!;
    expect(before.savings).toMatchObject({ rows: [], totalSaved: 0n, addedToSavings: 0n });

    const r = await setSavingsBucket(env.ctx, id, { enabled: true, openingMilli: $("2000") });
    expect(r.operationId).toBeTruthy();
    const [cat] = await env.db.select().from(categories).where(eq(categories.id, id));
    expect(cat).toMatchObject({ bucketKind: "savings", rollover: false, rolloverFrom: MONTH, rolloverOpeningMilli: $("2000"), savingsTargetMilli: null });
    const [audit] = await env.db.select().from(auditLog).where(and(eq(auditLog.action, "budget.enable_savings"), eq(auditLog.entityId, id)));
    expect(audit).toBeTruthy();
    // the monthly goal is gone from this month on
    const [goal] = await env.db.select().from(targets).where(and(eq(targets.categoryId, id), eq(targets.effectiveFrom, MONTH)));
    expect(goal?.removed).toBe(true);

    const after = await month();
    expect(after.groups.flatMap((g) => g.rows).some((r) => r.id === id)).toBe(false);
    const sv = after.savings.rows.find((x) => x.id === id)!;
    const assigned = (await env.db.execute<{ a: bigint }>(sql`SELECT coalesce(sum(assigned_milli), 0)::bigint AS a FROM month_assignments WHERE category_id = ${id} AND month = ${MONTH}::date`)).rows[0]!.a;
    const spent = (await spentByCategoryMonth(env.db, MONTH, MONTH, [id])).get(id)?.get(MONTH) ?? 0n;
    expect(sv).toMatchObject({ bucketKind: "savings", goal: null, budget: null, rollover: false });
    expect(sv.savings).toMatchObject({ carryIn: $("2000"), contributed: BigInt(assigned), spent, balance: $("2000") + BigInt(assigned) - spent, target: null, progress: null, from: MONTH, started: true });
    expect(after.savings.totalSaved).toBe(sv.savings!.balance);
    expect(after.savings.addedToSavings).toBe(BigInt(assigned));

    // excluded from the summary and the group totals
    expect(before.totals.budget - after.totals.budget).toBe(row.budget!);
    expect(after.totals.spent).toBe(before.totals.spent - row.spent);
    const g2 = after.groups.find((g) => g.id === group.id);
    if (g2) expect(g2.spent).toBe(group.spent - row.spent);
    const recomputed = bucketTotals(after.groups.flatMap((g) => g.rows).map((x) => ({ budget: x.budget, spent: x.spent, kind: x.goal?.kind ?? null })));
    expect(after.totals).toEqual(recomputed);
  });

  it("adding money raises the balance without touching what's left to spend; undo takes it back", async () => {
    const id = await categoryId("Taxes");
    const before = await month();
    const sv0 = before.savings.rows.find((x) => x.id === id)!.savings!;
    const r = await addToSavings(env.ctx, id, $("250"));
    expect(r.operationId).toBeTruthy();
    const after = await month();
    const sv = after.savings.rows.find((x) => x.id === id)!.savings!;
    expect(sv.balance - sv0.balance).toBe($("250"));
    expect(sv.contributed - sv0.contributed).toBe($("250"));
    expect(after.savings.addedToSavings - before.savings.addedToSavings).toBe($("250"));
    // adding moves money from Ready to save into the bucket; the cash itself doesn't change
    expect(after.savings.ready!.cash).toBe(before.savings.ready!.cash);
    expect(before.savings.ready!.amount - after.savings.ready!.amount).toBe($("250"));
    expect(after.totals).toEqual(before.totals);
    expect(after.pace).toEqual(before.pace);
    const [audit] = await env.db.select().from(auditLog).where(and(eq(auditLog.action, "budget.add_to_savings"), eq(auditLog.entityId, id)));
    expect(audit).toBeTruthy();
    // the add shows in this month's history
    const hist = await savingsContributions(env.db, id, MONTH);
    expect(hist[0]).toMatchObject({ operationId: r.operationId, amount: $("250"), userName: "Alex" });
    // next month starts with it
    const nov = (await savingsRow(id, "2026-11-01"))!.savings!;
    expect(nov.carryIn).toBe(sv.balance > 0n ? sv.balance : 0n);

    await undo(env.ctx, r.operationId!);
    expect((await savingsRow(id))!.savings!.balance).toBe(sv0.balance);
    expect(await savingsContributions(env.db, id, MONTH)).toEqual([]);
  });

  it("taking out is limited to the balance", async () => {
    const id = await categoryId("Taxes");
    const bal = (await savingsRow(id))!.savings!.balance;
    expect(bal).toBeGreaterThan($("100"));
    await expect(addToSavings(env.ctx, id, -(bal + 10n))).rejects.toThrow(/Can't take out/);
    const r = await addToSavings(env.ctx, id, $("-100"));
    expect((await savingsRow(id))!.savings!.balance).toBe(bal - $("100"));
    const [audit] = await env.db.select().from(auditLog).where(and(eq(auditLog.action, "budget.take_from_savings"), eq(auditLog.entityId, id)));
    expect(audit).toBeTruthy();
    await undo(env.ctx, r.operationId!);
    await expect(addToSavings(env.ctx, id, 0n)).rejects.toThrow(/zero/);
    await expect(addToSavings(env.ctx, id, $("10"), SEP)).rejects.toThrow(/starts saving/);
    await expect(addToSavings(env.ctx, await categoryId("Groceries"), $("10"))).rejects.toThrow(/isn't a savings bucket/);
    await expect(setBucketRollover(env.ctx, id, { enabled: true })).rejects.toThrow(/savings bucket/);
  });

  it("a start month in the past walks each month's assignments and spending, and earlier months don't count", async () => {
    const id = await categoryId("House Projects");
    await setSavingsBucket(env.ctx, id, { enabled: true, fromMonth: JUL, openingMilli: $("500"), targetMilli: $("15000") });
    const assigned = await env.db.execute<{ month: string; a: bigint }>(sql`SELECT to_char(month, 'YYYY-MM-DD') AS month, assigned_milli AS a FROM month_assignments WHERE category_id = ${id}`);
    const a = new Map(assigned.rows.map((x) => [x.month, BigInt(x.a)]));
    const spent = (await spentByCategoryMonth(env.db, JUL, MONTH, [id])).get(id) ?? new Map<Month, bigint>();
    let carry = $("500");
    for (let m: Month = JUL; m <= MONTH; m = addMonths(m, 1)) {
      const sv = (await savingsRow(id, m))!.savings!;
      const bal = carry + (a.get(m) ?? 0n) - (spent.get(m) ?? 0n);
      expect(sv).toMatchObject({ carryIn: carry, contributed: a.get(m) ?? 0n, spent: spent.get(m) ?? 0n, balance: bal, target: $("15000") });
      expect(sv.progress).toBe(savingsProgress(bal, $("15000")));
      carry = bal > 0n ? bal : 0n;
    }
    expect((await savingsMonths(env.db, MONTH)).get(id)!.balance).toBe((await savingsRow(id))!.savings!.balance);
    // June is before the start: nothing counts, and the bucket still isn't spending money
    expect((await savingsRow(id, "2026-06-01"))!.savings).toMatchObject({ started: false, balance: 0n, contributed: 0n, carryIn: 0n });
    expect(await spendingRow(id, "2026-06-01")).toBeUndefined();
  });

  it("a balance goal becomes the target; setSavingsTarget changes it; undo restores", async () => {
    const id = await categoryId("Emergency Fund");
    await setSavingsBucket(env.ctx, id, { enabled: true, openingMilli: $("15000") });
    let sv = (await savingsRow(id))!.savings!;
    expect(sv.target).toBe($("20000"));
    expect(sv.progress).toBe(savingsProgress(sv.balance, $("20000")));
    const t = await setSavingsTarget(env.ctx, id, $("25000"));
    expect((await savingsRow(id))!.savings!.target).toBe($("25000"));
    await setSavingsTarget(env.ctx, id, null);
    sv = (await savingsRow(id))!.savings!;
    expect(sv).toMatchObject({ target: null, progress: null });
    await expect(setSavingsTarget(env.ctx, id, 0n)).rejects.toThrow();
    await expect(setSavingsTarget(env.ctx, await categoryId("Groceries"), $("10"))).rejects.toThrow(/isn't a savings bucket/);
    expect(t.operationId).toBeTruthy();
  });

  it("editing the starting balance keeps the start month; turning it off puts the bucket back; undo restores the goal", async () => {
    const id = await categoryId("Taxes");
    await setSavingsBucket(env.ctx, id, { enabled: true, openingMilli: $("3000") });
    expect((await savingsRow(id))!.savings).toMatchObject({ from: MONTH, carryIn: $("3000"), opening: $("3000") });
    const off = await setSavingsBucket(env.ctx, id, { enabled: false });
    expect(await savingsRow(id)).toBeUndefined();
    const back = (await spendingRow(id))!;
    expect(back).toMatchObject({ bucketKind: "spending", goal: null });
    await undo(env.ctx, off.operationId!);
    expect((await savingsRow(id))!.savings!.opening).toBe($("3000"));

    // undoing the very first "enable" restores the monthly goal
    const fresh = await categoryId("Extra House Payments");
    const on = await setSavingsBucket(env.ctx, fresh, { enabled: true });
    expect(await spendingRow(fresh)).toBeUndefined();
    await undo(env.ctx, on.operationId!);
    expect(await spendingRow(fresh)).toMatchObject({ bucketKind: "spending", goalAmount: $("300") });
  });

  it("income is the engine's income for the month", async () => {
    const m = await month();
    expect(m.income).toBe((await getBudgetMonth(env.db, MONTH, { today: env.ctx.today })).summary.income);
    expect(m.income).toBeGreaterThan(0n);
  });

  it("rejects non-bucket categories and bad input", async () => {
    const rta = await env.db.execute<{ id: string }>(sql`SELECT id FROM categories WHERE kind = 'internal_rta'`);
    await expect(setSavingsBucket(env.ctx, rta.rows[0]!.id, { enabled: true })).rejects.toThrow(/can't be a savings bucket/);
    const id = await categoryId("Groceries");
    await expect(setSavingsBucket(env.ctx, id, { enabled: true, openingMilli: -1n })).rejects.toThrow();
    await expect(setSavingsBucket(env.ctx, id, { enabled: true, fromMonth: "2026-10-15" })).rejects.toThrow();
    await expect(setSavingsBucket(env.ctx, id, { enabled: true, targetMilli: 0n })).rejects.toThrow();
  });
});

describe("Ready to save", () => {
  const row = (budget: bigint | null, remaining: bigint, kind: "monthly" | "balance" | null, carryIn = 0n) => ({ budget, remaining, carryIn, goal: kind ? ({ kind } as never) : null });
  it("cash minus what buckets still hold minus savings; overspent and balance-goal buckets hold nothing", () => {
    const r = readyToSave($("10000"), [row($("600"), $("250"), "monthly"), row($("100"), $("-40"), "monthly"), row($("5000"), $("4000"), "balance"), row($("80"), $("80"), null, $("80")), row(null, $("-30"), null)], [$("1200"), $("-50")]);
    expect(r).toEqual({ cash: $("10000"), inBuckets: $("330"), inSavings: $("1200"), amount: $("8470") });
  });
  it("is only computed for the current month, from posted on-budget balances", async () => {
    const cur = await month();
    const cash = (await env.db.execute<{ c: bigint }>(sql`SELECT coalesce(sum(t.amount_milli),0)::bigint AS c FROM transactions t JOIN accounts a ON a.id=t.account_id
      WHERE t.deleted_at IS NULL AND a.deleted_at IS NULL AND a.on_budget AND t.cleared <> 'pending' AND t.date <= ${TODAY}::date`)).rows[0]!.c;
    expect(cur.savings.ready!.cash).toBe(BigInt(cash));
    expect(cur.savings.ready!.inSavings).toBe(cur.savings.rows.reduce((a, r) => a + (r.savings!.balance > 0n ? r.savings!.balance : 0n), 0n));
    expect((await month(addMonths(MONTH, -1))).savings.ready).toBeNull();
  });
});
