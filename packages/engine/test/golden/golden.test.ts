/**
 * §6.9 Golden parity tests (required acceptance gate).
 *
 * Real fixture: fixtures/private/ynab/plan.json — raw `GET /plans/{id}` response (gitignored).
 * If it is absent the real-data test is skipped, not failed.
 * Env:
 *   HOMEBASE_GOLDEN_FIXTURE   alternative path to the plan JSON
 *   HOMEBASE_GOLDEN_OPTIONS   JSON BudgetOptions overrides, e.g. '{"overspendAttribution":"cash_first"}'
 *   HOMEBASE_GOLDEN_GOAL_MONTH  month (YYYY-MM-01) to compare goal_under_funded (default: plan last_modified_on)
 *   HOMEBASE_GOLDEN_STRICT=1    also fail on the tolerated open-month residual (ADR-E13)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatDiffTable, goalMonthFor, partitionDiffs, runGolden } from "./compare";
import { unwrapYnabPlan, ynabPlanToSnapshot } from "./ynabToSnapshot";

const here = dirname(fileURLToPath(import.meta.url));
const realPath = process.env.HOMEBASE_GOLDEN_FIXTURE ?? resolve(here, "../../../../fixtures/private/ynab/plan.json");
const hasReal = existsSync(realPath);
const envOptions = process.env.HOMEBASE_GOLDEN_OPTIONS ? JSON.parse(process.env.HOMEBASE_GOLDEN_OPTIONS) : {};

describe.skipIf(!hasReal)("golden parity vs YNAB (private fixture)", () => {
  it("assigned/activity/available per category per month and to_be_budgeted match exactly", () => {
    const raw = JSON.parse(readFileSync(realPath, "utf8"));
    const mapped = ynabPlanToSnapshot(raw);
    const goalMonth = goalMonthFor(unwrapYnabPlan(raw).plan as { last_modified_on?: unknown }, process.env.HOMEBASE_GOLDEN_GOAL_MONTH);
    const report = runGolden(mapped, { budget: envOptions, goalMonth });
    if (mapped.warnings.length) console.warn(`mapper warnings:\n  ${mapped.warnings.slice(0, 50).join("\n  ")}`);
    if (report.result.warnings.length) console.warn(`engine warnings:\n  ${report.result.warnings.slice(0, 50).join("\n  ")}`);
    if (report.rows.length) console.log(formatDiffTable(report.rows));
    const { fatal, tolerated } = partitionDiffs(report.rows, goalMonth, process.env.HOMEBASE_GOLDEN_STRICT === "1");
    if (tolerated.length) console.warn(`golden parity: ${tolerated.length} open-month payment-category difference(s) tolerated (net zero across cards; ADR-E13). Set HOMEBASE_GOLDEN_STRICT=1 to fail on them.`);
    // informational: Age of Money (§6.7 [VERIFY]) is not asserted
    const aom = mapped.expected.filter((e) => e.ageOfMoney !== null).map((e) => `${e.month.slice(0, 7)} ynab=${e.ageOfMoney} engine=${report.result.months[e.month]?.ageOfMoney ?? "null"}`);
    if (aom.length) console.log(`age of money (info):\n  ${aom.slice(-12).join("\n  ")}`);
    expect(fatal).toEqual([]);
  });
});

describe("golden harness on the synthetic YNAB fixture", () => {
  const raw = JSON.parse(readFileSync(resolve(here, "synthetic/plan.json"), "utf8"));

  it("maps the plan export", () => {
    const mapped = ynabPlanToSnapshot(raw);
    const s = mapped.snapshot;
    expect(mapped).toMatchObject({ planId: "plan-synthetic", planName: "Synthetic Plan", serverKnowledge: 4242, firstMonth: "2026-09-01", lastMonth: "2026-10-01" });
    expect(s.accounts.map((a) => [a.id, a.kind, a.onBudget, a.closed])).toEqual([
      ["chk", "checking", true, false],
      ["visa", "credit_card", true, false],
      ["brok", "other", false, false],
      ["car", "loan", false, true],
    ]);
    const kinds = Object.fromEntries(s.categories.map((c) => [c.id, [c.kind, c.linkedAccountId, c.hidden, !!c.deleted]]));
    expect(kinds).toMatchObject({
      rta: ["internal_rta", null, true, false],
      uncat: ["uncategorized", null, true, false],
      ccint: ["normal", null, true, false],
      "pay-visa": ["cc_payment", "visa", false, false],
      old: ["normal", null, true, true],
    });
    expect(s.groups.find((g) => g.id === "g-hidden")!.hidden).toBe(true);
    const split = s.transactions.find((t) => t.id === "t-split")!;
    expect(split.categoryId).toBeNull();
    expect(split.splits!.map((p) => [p.categoryId, p.amount])).toEqual([["groc", -40000n], ["fun", -20000n]]);
    expect(s.transactions.find((t) => t.id === "t-sb-visa")!.isStartingBalance).toBe(true);
    expect(s.transactions.find((t) => t.id === "t-deleted")!.deleted).toBe(true);
    expect(s.transactions.find((t) => t.id === "t-pay2")!.cleared).toBe("uncleared");
    expect(s.assignments).toContainEqual({ month: "2026-09-01", categoryId: "pay-visa", assigned: 100000n });
    expect(s.targets.map((t) => [t.categoryId, t.type, t.amount, t.effectiveFrom])).toEqual([
      ["rent", "monthly_builder", 1500000n, "2026-09-01"],
      ["groc", "need_set_aside", 200000n, "2026-09-01"],
    ]);
    expect(s.scheduled.find((x) => x.id === "s-split")).toMatchObject({ frequency: "once", nextDate: "2026-10-30", splits: [{ categoryId: "fun", amount: -20000n }, { categoryId: "groc", amount: -10000n }] });
    expect(s.scheduled.find((x) => x.id === "s-old")!.frequency).toBe("biweekly");
    expect(mapped.expected[1]).toMatchObject({ month: "2026-10-01", toBeBudgeted: 4800000n, income: 2000000n, budgeted: 150000n, activity: -45000n, ageOfMoney: null });
    expect(mapped.categoryNames["groc"]).toBe("🛒 Groceries");
    expect(mapped.warnings).toEqual([]);
  });

  it("engine reproduces the fixture's months exactly (diff table is empty)", () => {
    const mapped = ynabPlanToSnapshot(raw);
    const report = runGolden(mapped, { goalMonth: goalMonthFor(raw.data.plan, undefined) });
    expect(report.goalMonth).toBe("2026-10-01");
    expect(formatDiffTable(report.rows)).toBe("golden parity: no differences");
    expect(report.checked).toBeGreaterThan(15);
    const oct = report.result.months["2026-10-01"]!;
    expect(oct.categories["uncat"]!.cashOverspend).toBe(25000n);
    expect(oct.categories["rent"]!.upcoming).toBe(0n);
    expect(oct.categories["fun"]!.upcoming).toBe(20000n);
  });

  it("prints a readable diff table on mismatch", () => {
    const tampered = structuredClone(raw);
    const oct = tampered.data.plan.months[1];
    oct.to_be_budgeted = 4700000;
    oct.categories.find((c: { id: string }) => c.id === "groc").balance = 110000;
    oct.categories.find((c: { id: string }) => c.id === "rent").goal_under_funded = 1;
    oct.categories.push({ id: "ghost", category_group_id: "g-needs", name: "Ghost", hidden: false, budgeted: 5000, activity: 0, balance: 5000 });
    oct.categories.push({ id: "ghost0", category_group_id: "g-needs", name: "Ghost0", hidden: false, budgeted: 0, activity: 0, balance: 0 });
    const mapped = ynabPlanToSnapshot(tampered);
    const report = runGolden(mapped, { goalMonth: "2026-10-01" });
    expect(report.rows.map((r) => [r.field, r.categoryId])).toEqual([
      ["to_be_budgeted", ""],
      ["goal_under_funded", "rent"],
      ["available", "groc"],
      ["missing", "ghost"],
    ]);
    const table = formatDiffTable(report.rows);
    expect(table).toContain("golden parity: 4 difference(s)");
    expect(table).toContain("🛒 Groceries");
    expect(table).toContain("$10.00"); // Δ
    expect(formatDiffTable(report.rows, 1)).toContain("… 3 more");
  });

  it("reports months the engine did not produce", () => {
    const mapped = ynabPlanToSnapshot(raw);
    mapped.expected.push({ month: "2026-12-01", toBeBudgeted: 0n, ageOfMoney: null, income: null, budgeted: null, activity: null, categories: {} });
    mapped.lastMonth = "2026-10-01";
    expect(runGolden(mapped).rows).toEqual([{ month: "2026-12-01", categoryId: "", name: "(month)", field: "missing", ynab: 0n, engine: null }]);
  });

  it("open-month tolerance only covers net-zero payment-category differences", () => {
    const row = (month: string, kind: string, field: "activity" | "available" | "to_be_budgeted", ynab: bigint, engine: bigint) => ({ month, categoryId: kind + ynab, name: "x", kind, field, ynab, engine });
    const pair = [row("2026-10-01", "cc_payment", "activity", 100n, 110n), row("2026-10-01", "cc_payment", "activity", 50n, 40n)];
    expect(partitionDiffs(pair, "2026-10-01", false)).toEqual({ fatal: [], tolerated: pair });
    expect(partitionDiffs(pair, "2026-10-01", true).fatal).toHaveLength(2);
    expect(partitionDiffs(pair, null, false).fatal).toHaveLength(2);
    expect(partitionDiffs(pair, "2026-11-01", false).fatal).toHaveLength(2); // closed month
    const lopsided = [row("2026-10-01", "cc_payment", "activity", 100n, 110n)];
    expect(partitionDiffs(lopsided, "2026-10-01", false).fatal).toHaveLength(1);
    const mixed = [...pair, row("2026-10-01", "", "to_be_budgeted", 1n, 2n)];
    expect(partitionDiffs(mixed, "2026-10-01", false).fatal).toHaveLength(1);
  });

  it("goal month helper", () => {
    expect(goalMonthFor({ last_modified_on: "2026-10-22T15:00:00Z" }, undefined)).toBe("2026-10-01");
    expect(goalMonthFor({}, "2026-09-15")).toBe("2026-09-01");
    expect(goalMonthFor({}, undefined)).toBeNull();
  });
});
