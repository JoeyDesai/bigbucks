import { describe, expect, it } from "vitest";
import { addMonths } from "@homebase/shared";
import { eq } from "drizzle-orm";
import { categories } from "@homebase/db";
import { HIDDEN_GROUP_ID, getBucketMonth, spentByCategory } from "../src/buckets/month";
import { clearBudgetMemo } from "../src/budget/cache";
import { getReflect, reflectMonths } from "../src/buckets/reflect";
import { MONTH, TODAY, useDemoDb } from "./helpers";

const env = useDemoDb();

describe("getReflect (demo)", () => {
  it("windows months oldest first, ending at the month", () => {
    expect(reflectMonths(MONTH, 3)).toEqual([addMonths(MONTH, -2), addMonths(MONTH, -1), MONTH]);
  });

  it("bucket spending per month matches the Budget screen, and totals add up", async () => {
    const r = await getReflect(env.db, MONTH, { months: 6 });
    expect(r.months).toHaveLength(6);
    expect(r.months.at(-1)).toBe(MONTH);
    const last = r.months.length - 1;
    const budget = await spentByCategory(env.db, MONTH);
    for (const b of r.buckets) {
      expect(b.spent).toHaveLength(6);
      expect(b.spent[last]).toBe(budget.get(b.id)?.spent ?? 0n);
      expect(b.total).toBe(b.spent.reduce((a, v) => a + v, 0n));
      expect(b.spent.some((v) => v !== 0n)).toBe(true);
    }
    r.months.forEach((_, i) => expect(r.spent[i]).toBe(r.buckets.reduce((a, b) => a + b.spent[i]!, 0n)));
    const m = await getBucketMonth(env.db, MONTH, { today: TODAY });
    expect(r.income[last]).toBe(m.income);
    expect(r.uncategorized[last]).toBe(m.uncategorized.spent);
  });

  it("lists the month's biggest places, largest first", async () => {
    const r = await getReflect(env.db, MONTH, { places: 4 });
    expect(r.places.length).toBeGreaterThan(0);
    expect(r.places.length).toBeLessThanOrEqual(4);
    for (let i = 1; i < r.places.length; i++) expect(r.places[i - 1]!.spent >= r.places[i]!.spent).toBe(true);
    expect(r.places.every((p) => p.spent > 0n && p.count > 0 && p.name)).toBe(true);
  });

  it("the Budget screen's spending matches Reflect, even when a bucket with spending is hidden", async () => {
    const budgetSpent = async () => {
      clearBudgetMemo();
      const m = await getBucketMonth(env.db, MONTH, { today: TODAY });
      return { m, total: m.totals.spent + m.savings.rows.reduce((a, r) => a + r.spent, 0n) };
    };
    const r = await getReflect(env.db, MONTH, { months: 1 });
    expect((await budgetSpent()).total).toBe(r.spent[0]);
    const target = r.buckets.find((b) => b.bucketKind === "spending" && b.spent[0]! > 0n)!;
    await env.db.update(categories).set({ hidden: true }).where(eq(categories.id, target.id));
    try {
      const { m, total } = await budgetSpent();
      expect(total).toBe(r.spent[0]);
      const last = m.groups.at(-1)!;
      expect(last.id).toBe(HIDDEN_GROUP_ID);
      expect(last.rows.map((x) => x.id)).toEqual([target.id]);
      expect(last.rows[0]!.groupId).not.toBe(HIDDEN_GROUP_ID);
    } finally {
      await env.db.update(categories).set({ hidden: false }).where(eq(categories.id, target.id));
      clearBudgetMemo();
    }
  });
});
