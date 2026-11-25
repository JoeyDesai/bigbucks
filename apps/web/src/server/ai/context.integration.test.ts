/**
 * The AiToolContext and the default ActionExecutor against the demo seed: every read tool returns
 * sane shapes, and every write tool goes through core and lands in the database.
 */
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, ilike, isNull } from "drizzle-orm";
import { schema as s } from "@homebase/db";
import { getBudgetMonth } from "@homebase/core";
import { prepareWebTestDb } from "@/test/db";
import { createAiToolContext, defaultActionExecutor, listCategoryRefs } from "./context";

const SUITE = "aictx";
const t = await prepareWebTestDb(SUITE);

describe.skipIf(!t)("AI tool context + executor (Postgres)", () => {
  const db = t!.db;
  afterAll(async () => t?.close());
  const today = "2026-10-22";
  const ctx = createAiToolContext(db, { userId: null, webLookupEnabled: false, today });
  const meta = async () => {
    const [u] = await db.select().from(s.users).where(eq(s.users.role, "admin"));
    return { actionId: "x", confirmedBy: u!.id, userId: u!.id };
  };
  const cat = async (name: string) => (await listCategoryRefs(db)).find((c) => c.name.includes(name))!;

  it("read tools", async () => {
    const ov = await ctx.getOverview();
    expect(ov.month).toBe("2026-10-01");
    expect(typeof ov.readyToAssign).toBe("bigint");
    expect(ov.lastSync.length).toBeGreaterThan(0);

    const bm = await ctx.getBudgetMonth("2026-10-01");
    expect(bm.categories.some((c) => c.category.includes("Giving") && c.target)).toBe(true);

    const q = await ctx.queryTransactions({ startDate: "2026-09-01", endDate: "2026-09-30", direction: "outflow", limit: 20 });
    expect(q.rows.length).toBeGreaterThan(0);
    expect(q.rows.every((r) => r.amount < 0n)).toBe(true);
    expect(q.totals.outflow).toBeLessThan(0n);
    const lowes = await ctx.queryTransactions({ payeeText: "Lowe", limit: 50 });
    expect(lowes.rows.every((r) => /lowe/i.test(r.payee ?? ""))).toBe(true);

    for (const groupBy of ["category", "group", "payee", "month", "account"] as const) {
      const ss = await ctx.spendingSummary({ groupBy, startDate: "2026-09-01", endDate: "2026-09-30", limit: 5 });
      expect(ss.rows.length).toBeLessThanOrEqual(5);
      expect(ss.total.net).toBe(ss.total.outflow + ss.total.inflow);
    }
    const nw = await ctx.netWorth({ startDate: "2026-01-01", endDate: today, granularity: "month" });
    expect(nw.points.length).toBeGreaterThan(5);
    const h = await ctx.holdings({});
    expect(h.holdings.length).toBeGreaterThan(0);

    expect(await ctx.getMerchantProfile("Some Unknown Shop")).toMatchObject({ found: false, description: expect.stringContaining("turned off") });
    expect(await ctx.getTransactionsByIds([lowes.rows[0]?.id ?? "", "not-a-uuid"])).toHaveLength(lowes.rows[0] ? 1 : 0);
    await expect(ctx.queryTransactions({ categoryIds: ["nope"], limit: 5 })).rejects.toThrow(/Unknown id/);
    expect((await ctx.previewRule!({ payee_contains: "Lowe", apply_to_existing: true, category_id: (await cat("House Projects")).id })).matchCount).toBeGreaterThan(0);
    const rep = await ctx.saveReport("Test chart", { type: "bar", title: "T", format: "currency", series: [{ name: "a", data: [{ x: "Jan", y: 1 }] }] });
    expect(rep.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("write tools go through core", async () => {
    const m = await meta();
    const ex = defaultActionExecutor(db, m.userId, today);
    const house = await cat("House Projects");
    const misc = await cat("Misc");
    const groceries = await cat("Groceries");

    // create_rule + apply_to_existing (the §11.4 Lowe's prompt)
    const r = await ex.create_rule({ payee_contains: "Lowe", category_id: house.id, apply_to_existing: true }, m);
    expect(r.entity).toBe("rule");
    const [rule] = await db.select().from(s.rules).where(eq(s.rules.id, r.entityId!));
    expect(rule).toMatchObject({ source: "user", conditions: [{ field: "payee", op: "contains", value: "Lowe" }], actions: { setCategoryId: house.id } });
    const lowes = await db.select({ c: s.transactions.categoryId }).from(s.transactions).innerJoin(s.payees, eq(s.payees.id, s.transactions.payeeId)).where(and(ilike(s.payees.name, "%lowe%"), eq(s.transactions.isSplit, false), isNull(s.transactions.deletedAt)));
    expect(lowes.length).toBeGreaterThan(0);
    expect(lowes.every((x) => x.c === house.id)).toBe(true);

    // move money and assign (budget operations, recorded for undo)
    const before = (await getBudgetMonth(db, "2026-10-01", { today })).groups.flatMap((g) => g.categories).find((c) => c.id === groceries.id)!.assigned;
    await ex.move_money({ month: "2026-10", from_category_id: "ready_to_assign", to_category_id: groceries.id, amount: "10.00" }, m);
    await ex.assign({ month: "2026-10", category_id: groceries.id, amount: "5", mode: "add" }, m);
    const after = (await getBudgetMonth(db, "2026-10-01", { today })).groups.flatMap((g) => g.categories).find((c) => c.id === groceries.id)!.assigned;
    expect(after - before).toBe(15_000n);

    // target, category, memory
    await ex.update_target({ category_id: misc.id, target: { type: "need_set_aside", amount: "200", cadence: "monthly" } }, m);
    const [tg] = await db.select().from(s.targets).where(and(eq(s.targets.categoryId, misc.id), eq(s.targets.effectiveFrom, "2026-10-01")));
    expect(tg).toMatchObject({ type: "need_set_aside", amountMilli: 200_000n });
    const cc = await ex.create_category({ group: "Wants", name: "Hobbies" }, m);
    expect((await db.select().from(s.categories).where(eq(s.categories.id, cc.entityId!)))[0]?.name).toBe("Hobbies");

    // every core write was audited as the AI with the confirming user
    const audits = await db.select().from(s.auditLog).where(eq(s.auditLog.actor, "ai"));
    expect(audits.length).toBeGreaterThan(3);
    expect(audits.every((a) => a.confirmedBy === m.confirmedBy)).toBe(true);
  });
});
