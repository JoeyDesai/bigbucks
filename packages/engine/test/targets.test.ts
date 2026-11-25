import { describe, expect, it } from "vitest";
import {
  ceilCentsDiv,
  computeTargetMonth,
  effectiveTarget,
  indexTargets,
  mapYnabCadence,
  mapYnabGoal,
  parsePercent,
  percentOf,
  periodMonths,
  targetDue,
  targetPeriod,
  weeklyDueDates,
  YNAB_GOAL_CADENCE,
  type TargetInputs,
} from "../src/targets";
import type { EngineTarget } from "../src/types";
import { $, c, m, pay, snap } from "./helpers";

const T = (t: Partial<EngineTarget>): EngineTarget => ({
  categoryId: "x",
  effectiveFrom: "2026-01-01",
  type: "need_set_aside",
  amount: $(100),
  cadence: "monthly",
  cadenceEvery: 1,
  day: null,
  targetDate: null,
  percent: null,
  snoozedMonth: null,
  createdMonth: "2026-01-01",
  ...t,
});
const I = (p: Partial<TargetInputs>): TargetInputs => ({
  month: "2026-03-01",
  kind: "normal",
  target: null,
  carryIn: 0n,
  assigned: 0n,
  activity: 0n,
  assignedIn: () => 0n,
  income: 0n,
  upcoming: 0n,
  ...p,
});

describe("rounding and percent helpers", () => {
  it("ceilCentsDiv rounds up to whole cents", () => {
    expect(ceilCentsDiv($(1000), 12n)).toBe($(83.34));
    expect(ceilCentsDiv($(1200), 12n)).toBe($(100));
    expect(ceilCentsDiv(-5n, 3n)).toBe(0n);
  });
  it("parsePercent / percentOf", () => {
    expect(parsePercent("10")).toBe(10_000_000n);
    expect(parsePercent(12.5)).toBe(12_500_000n);
    expect(parsePercent("-1.5")).toBe(-1_500_000n);
    expect(() => parsePercent("abc")).toThrow();
    expect(percentOf($(9800), "10")).toBe($(980));
    expect(percentOf($(1000.05), "10")).toBe($(100.01)); // 100.005 → half-up
    expect(percentOf($(-100), "10")).toBe($(-10));
  });
});

describe("§6.5 needed(M) by type", () => {
  it("need_set_aside monthly: X regardless of carry", () => {
    const r = computeTargetMonth(I({ target: T({}), carryIn: $(70), assigned: $(40) }));
    expect(r).toMatchObject({ needed: $(100), underfunded: $(60), overallLeft: $(60), pctComplete: 40, hasTarget: true });
  });

  it("need_set_aside weekly: X × number of `day` weekdays in M", () => {
    // March 2026 has 5 Sundays? 1,8,15,22,29 → yes 5
    const r = computeTargetMonth(I({ target: T({ cadence: "weekly", day: 0, amount: $(50) }) }));
    expect(r.needed).toBe($(250));
    const r2 = computeTargetMonth(I({ month: "2026-02-01", target: T({ cadence: "weekly", day: 0, amount: $(50) }) }));
    expect(r2.needed).toBe($(200));
  });

  it("need_set_aside every 2 weeks uses the target date as anchor", () => {
    const t = T({ cadence: "weekly", cadenceEvery: 2, day: 0, amount: $(50), targetDate: "2026-03-01" });
    expect(weeklyDueDates(t, "2026-03-01")).toEqual(["2026-03-01", "2026-03-15", "2026-03-29"]);
    expect(computeTargetMonth(I({ target: t })).needed).toBe($(150));
  });

  it("need_set_aside yearly: (X − assigned earlier in period) ÷ months left", () => {
    const t = T({ cadence: "yearly", amount: $(1200), targetDate: "2026-12-15" });
    const assigned: Record<string, bigint> = { "2026-01-01": $(100), "2026-02-01": $(100) };
    const r = computeTargetMonth(I({ target: t, assignedIn: (mm) => assigned[mm] ?? 0n, assigned: $(50) }));
    // period Jan–Dec 2026, months left incl. March = 10, prior 200 → 1000/10 = 100
    expect(r).toMatchObject({ needed: $(100), underfunded: $(50), overallLeft: $(950) });
    expect(r.pctComplete).toBe(20);
  });

  it("need_set_aside yearly rolls to the next period after the due month", () => {
    const t = T({ cadence: "yearly", amount: $(1200), targetDate: "2025-12-15" });
    expect(targetPeriod(t, "2026-03-01")).toEqual({ start: "2026-01-01", end: "2026-12-01", monthsLeft: 10 });
    expect(targetPeriod(t, "2025-06-01")).toEqual({ start: "2025-01-01", end: "2025-12-01", monthsLeft: 7 });
  });

  it("need_set_aside every N months (cadence 3–12) and monthly every N", () => {
    const t = T({ cadence: "every_n_months", cadenceEvery: 3, amount: $(300), targetDate: "2026-04-10" });
    expect(targetPeriod(t, "2026-03-01")).toEqual({ start: "2026-02-01", end: "2026-04-01", monthsLeft: 2 });
    expect(computeTargetMonth(I({ target: t, assignedIn: (mm) => (mm === "2026-02-01" ? $(100) : 0n) })).needed).toBe($(100));
    const t2 = T({ cadence: "monthly", cadenceEvery: 2, amount: $(200), targetDate: "2026-03-05" });
    expect(periodMonths(t2)).toBe(2);
    expect(computeTargetMonth(I({ target: t2 })).needed).toBe($(200));
  });

  it("need_set_aside without a target date anchors on effectiveFrom", () => {
    const t = T({ cadence: "every_n_months", cadenceEvery: 2, amount: $(200), effectiveFrom: "2026-02-01" });
    expect(targetPeriod(t, "2026-03-01")).toEqual({ start: "2026-02-01", end: "2026-03-01", monthsLeft: 1 });
  });

  it("need_set_aside one-time (cadence none, by date)", () => {
    const t = T({ cadence: "none", amount: $(600), targetDate: "2026-06-30", createdMonth: "2026-01-01" });
    // Jan–Feb assigned 100 each → 400 left over Mar–Jun (4) = 100
    const r = computeTargetMonth(I({ target: t, assignedIn: (mm) => (mm < "2026-03-01" ? $(100) : 0n) }));
    expect(r.needed).toBe($(100));
    // after the date: everything left is due now
    const late = computeTargetMonth(I({ month: "2026-08-01", target: t, assignedIn: (mm) => (mm < "2026-03-01" ? $(100) : 0n) }));
    expect(late.needed).toBe($(400));
    // cadence none without date: monthly
    expect(computeTargetMonth(I({ target: T({ cadence: "none" }) })).needed).toBe($(100));
  });

  it("need_refill monthly: max(X − carry, 0)", () => {
    expect(computeTargetMonth(I({ target: T({ type: "need_refill" }), carryIn: $(30) })).needed).toBe($(70));
    expect(computeTargetMonth(I({ target: T({ type: "need_refill" }), carryIn: $(130) })).needed).toBe(0n);
  });

  it("need_refill weekly and yearly", () => {
    expect(computeTargetMonth(I({ target: T({ type: "need_refill", cadence: "weekly", day: 0, amount: $(20) }), carryIn: $(30) })).needed).toBe($(70));
    const y = T({ type: "need_refill", cadence: "yearly", amount: $(1200), targetDate: "2026-12-01" });
    expect(computeTargetMonth(I({ target: y, carryIn: $(200) })).needed).toBe($(100));
    expect(computeTargetMonth(I({ month: "2027-01-01", target: T({ type: "need_refill", cadence: "none", amount: $(500), targetDate: "2026-12-01" }), carryIn: $(200) })).needed).toBe($(300));
  });

  it("balance: max(X − carry, 0); option to include activity", () => {
    const t = T({ type: "balance", amount: $(1000) });
    expect(computeTargetMonth(I({ target: t, carryIn: $(400), activity: $(-100), assigned: $(200) }))).toMatchObject({ needed: $(600), underfunded: $(400), overallLeft: $(400) });
    expect(computeTargetMonth(I({ target: t, carryIn: $(400), activity: $(-100), balanceTargetIncludesActivity: true })).needed).toBe($(700));
  });

  it("balance_by_date: (X − carry) ÷ months remaining incl. M", () => {
    const t = T({ type: "balance_by_date", amount: $(1000), targetDate: "2026-07-01", cadence: "none" });
    expect(computeTargetMonth(I({ target: t, carryIn: $(500) })).needed).toBe($(100)); // 500 / 5
    expect(computeTargetMonth(I({ month: "2026-09-01", target: t, carryIn: $(500) })).needed).toBe($(500));
    expect(computeTargetMonth(I({ target: T({ type: "balance_by_date", amount: $(1000), targetDate: null }) })).needed).toBe($(1000));
  });

  it("monthly_builder and debt: X", () => {
    expect(computeTargetMonth(I({ target: T({ type: "monthly_builder", amount: $(75) }), carryIn: $(500) })).needed).toBe($(75));
    expect(computeTargetMonth(I({ kind: "cc_payment", target: T({ type: "debt", amount: $(250) }), debt: $(5000) })).needed).toBe($(250));
  });

  it("percent_of_income: % of RTA inflows by default, overrides and gross pay basis", () => {
    const t = T({ type: "percent_of_income", percent: "10", amount: 0n });
    expect(computeTargetMonth(I({ target: t, income: $(9800) })).needed).toBe($(980));
    expect(computeTargetMonth(I({ target: t, income: $(9800), incomeOverrides: [{ month: "2026-03-01", basis: "rta_inflows", amount: $(1000) }] })).needed).toBe($(100));
    const g = T({ type: "percent_of_income", percent: 10, incomeBasis: "gross_pay" });
    expect(computeTargetMonth(I({ target: g, income: $(9800) })).needed).toBe(0n);
    expect(computeTargetMonth(I({ target: g, incomeOverrides: [{ month: "2026-03-01", basis: "gross_pay", amount: $(20000) }] })).needed).toBe($(2000));
    expect(computeTargetMonth(I({ target: T({ type: "percent_of_income", percent: null }), income: $(100) })).needed).toBe(0n);
    expect(computeTargetMonth(I({ target: t, income: $(-500) })).needed).toBe(0n);
  });

  it("snoozed targets need 0 that month but keep neededUnsnoozed", () => {
    const r = computeTargetMonth(I({ target: T({ snoozedMonth: "2026-03-01" }), assigned: $(20) }));
    expect(r).toMatchObject({ needed: 0n, neededUnsnoozed: $(100), underfunded: 0n, snoozed: true, overallLeft: 0n });
  });

  it("upcoming scheduled outflows add need when they exceed Available", () => {
    const r = computeTargetMonth(I({ upcoming: $(80), carryIn: $(30) }));
    expect(r).toMatchObject({ needed: $(50), scheduleNeeded: $(50), underfunded: $(50), hasTarget: false, overallLeft: $(50), pctComplete: 0 });
    // with a target, the larger need wins
    expect(computeTargetMonth(I({ target: T({}), upcoming: $(300) })).needed).toBe($(300));
    expect(computeTargetMonth(I({ target: T({}), upcoming: $(30) })).needed).toBe($(100));
    expect(computeTargetMonth(I({ upcoming: $(80), assigned: $(80) })).pctComplete).toBe(100);
    expect(computeTargetMonth(I({ upcoming: $(80), assigned: $(40) })).pctComplete).toBe(50);
  });

  it("payment categories without a target need their debt", () => {
    expect(computeTargetMonth(I({ kind: "cc_payment", debt: $(500), carryIn: $(200) })).needed).toBe($(300));
    expect(computeTargetMonth(I({ kind: "cc_payment", debt: $(500), carryIn: $(200), activity: $(300) })).needed).toBe(0n);
  });

  it("pct complete caps at 100 and handles zero targets", () => {
    expect(computeTargetMonth(I({ target: T({}), assigned: $(250) })).pctComplete).toBe(100);
    expect(computeTargetMonth(I({ target: T({ amount: 0n }) })).pctComplete).toBe(100);
    expect(computeTargetMonth(I({ target: T({ type: "need_refill" }), carryIn: 0n, assigned: $(-50) })).pctComplete).toBe(0);
  });
});

describe("§6.5 effective_from history", () => {
  it("past months keep the target that applied then; removed rows end a target", () => {
    const rows = indexTargets([T({ effectiveFrom: "2026-03-01", amount: $(200) }), T({ effectiveFrom: "2026-01-01", amount: $(100) }), T({ effectiveFrom: "2026-06-01", removed: true })]);
    expect(effectiveTarget(rows.get("x"), "2025-12-01")).toBeNull();
    expect(effectiveTarget(rows.get("x"), "2026-02-01")!.amount).toBe($(100));
    expect(effectiveTarget(rows.get("x"), "2026-04-01")!.amount).toBe($(200));
    expect(effectiveTarget(rows.get("x"), "2026-07-01")).toBeNull();
    expect(effectiveTarget(undefined, "2026-07-01")).toBeNull();
  });

  it("the engine applies target history month by month", () => {
    const r = snap()
      .account("chk")
      .cat("a")
      .income("chk", "2026-01-01", 1000)
      .target({ categoryId: "a", type: "need_set_aside", amount: $(100), effectiveFrom: "2026-01-01" })
      .target({ categoryId: "a", type: "need_set_aside", amount: $(150), effectiveFrom: "2026-02-01" })
      .run("2026-02");
    expect(c(r, "2026-01", "a").needed).toBe($(100));
    expect(c(r, "2026-02", "a").needed).toBe($(150));
    expect(m(r, "2026-02").costToBeMe).toBe($(150));
    expect(c(r, "2026-02", "a")).toMatchObject({ status: "underfunded", statusLabel: "$150.00 more needed" });
  });
});

describe("§6.5 in the engine: upcoming, cost to be me, percent of income", () => {
  it("upcoming scheduled transactions make a category 'upcoming'", () => {
    const r = snap()
      .account("chk")
      .cat("bills")
      .income("chk", "2026-03-01", 1000)
      .assign("2026-03", "bills", 20)
      .scheduled({ accountId: "chk", categoryId: "bills", amount: $(-90), frequency: "monthly", nextDate: "2026-03-20" })
      .run("2026-03");
    expect(c(r, "2026-03", "bills")).toMatchObject({ upcoming: $(90), needed: $(90), underfunded: $(70), status: "upcoming" });
  });

  it("split scheduled transactions, transfers and RTA lines", () => {
    const r = snap()
      .account("chk")
      .account("sav", "savings")
      .account("brok", "brokerage", false)
      .cat("a")
      .cat("b")
      .income("chk", "2026-03-01", 1000)
      .scheduled({ accountId: "chk", amount: $(-100), frequency: "once", nextDate: "2026-03-10", splits: [{ amount: $(-60), categoryId: "a", transferAccountId: null }, { amount: $(-40), categoryId: null, transferAccountId: null }] })
      .scheduled({ accountId: "chk", amount: $(-50), frequency: "once", nextDate: "2026-03-10", transferAccountId: "sav" })
      .scheduled({ accountId: "chk", amount: $(-70), frequency: "once", nextDate: "2026-03-10", transferAccountId: "brok", categoryId: "b" })
      .scheduled({ accountId: "chk", amount: $(500), frequency: "monthly", nextDate: "2026-03-15", categoryId: "rta" })
      .scheduled({ accountId: "chk", amount: $(-5), frequency: "monthly", nextDate: "2026-03-15", categoryId: "rta" })
      .scheduled({ accountId: "brok", amount: $(-5), frequency: "monthly", nextDate: "2026-03-15", categoryId: "a" })
      .scheduled({ accountId: "chk", amount: $(-9), frequency: "monthly", nextDate: "2026-03-15", categoryId: "a", deleted: true })
      .run("2026-03");
    expect(c(r, "2026-03", "a").upcoming).toBe($(60));
    expect(c(r, "2026-03", "uncat").upcoming).toBe($(40));
    expect(c(r, "2026-03", "b").upcoming).toBe($(70));
  });

  it("scheduled payment on the card side counts for P(K)", () => {
    const r = snap().account("chk").card("visa").scheduled({ accountId: "visa", transferAccountId: "chk", amount: $(200), frequency: "monthly", nextDate: "2026-03-15" }).run("2026-03");
    expect(c(r, "2026-03", pay("visa")).upcoming).toBe($(200));
  });

  it("percent_of_income recalculates as income arrives (Giving)", () => {
    const r = snap().account("chk").cat("giving").income("chk", "2026-03-01", 4900).income("chk", "2026-03-15", 4900).target({ categoryId: "giving", type: "percent_of_income", percent: "10" }).run("2026-03");
    expect(c(r, "2026-03", "giving").needed).toBe($(980));
  });

  it("deleted categories are excluded from cost to be me", () => {
    const r = snap().account("chk").cat("old", { deleted: true }).cat("a").target({ categoryId: "old", type: "monthly_builder", amount: $(50) }).target({ categoryId: "a", type: "monthly_builder", amount: $(20) }).income("chk", "2026-01-01", 1).run("2026-01");
    expect(m(r, "2026-01").costToBeMe).toBe($(20));
    expect(m(r, "2026-01").underfunded).toBe($(20));
  });
});

describe("due dates (auto-assign ordering)", () => {
  it("classifies targets", () => {
    expect(targetDue(T({ cadence: "weekly", day: 6 }), "2026-03-01")).toEqual({ kind: "dated", date: "2026-03-07" });
    expect(targetDue(T({ type: "balance" }), "2026-03-01")).toEqual({ kind: "none" });
    expect(targetDue(T({ type: "balance_by_date", targetDate: "2026-09-01", cadence: "none" }), "2026-03-01")).toEqual({ kind: "future", month: "2026-09-01" });
    expect(targetDue(T({ type: "balance_by_date", targetDate: "2026-03-09", cadence: "none" }), "2026-03-01")).toEqual({ kind: "dated", date: "2026-03-09" });
    expect(targetDue(T({ cadence: "yearly", targetDate: "2026-12-01" }), "2026-03-01")).toEqual({ kind: "future", month: "2026-12-01" });
    expect(targetDue(T({ day: 31 }), "2026-02-01")).toEqual({ kind: "dated", date: "2026-02-28" });
    expect(targetDue(T({}), "2026-03-01")).toEqual({ kind: "end_of_month" });
  });
});

describe("YNAB goal mapping (§10)", () => {
  it("cadence codes match the OpenAPI description", () => {
    expect(YNAB_GOAL_CADENCE[3]!.label).toBe("Every 2 Months");
    expect(YNAB_GOAL_CADENCE[12]!.label).toBe("Every 11 Months");
    expect(YNAB_GOAL_CADENCE[14]!.label).toBe("Every 2 Years");
    expect(mapYnabCadence(0, 5)).toEqual({ cadence: "none", cadenceEvery: 1 });
    expect(mapYnabCadence(1, 1)).toEqual({ cadence: "monthly", cadenceEvery: 1 });
    expect(mapYnabCadence(1, 2)).toEqual({ cadence: "every_n_months", cadenceEvery: 2 });
    expect(mapYnabCadence(2, 2)).toEqual({ cadence: "weekly", cadenceEvery: 2 });
    expect(mapYnabCadence(4, 9)).toEqual({ cadence: "every_n_months", cadenceEvery: 3 });
    expect(mapYnabCadence(12, null)).toEqual({ cadence: "every_n_months", cadenceEvery: 11 });
    expect(mapYnabCadence(13, 1)).toEqual({ cadence: "yearly", cadenceEvery: 1 });
    expect(mapYnabCadence(13, 3)).toEqual({ cadence: "yearly", cadenceEvery: 3 });
    expect(mapYnabCadence(14, 7)).toEqual({ cadence: "yearly", cadenceEvery: 2 });
    expect(mapYnabCadence(null, null)).toEqual({ cadence: "none", cadenceEvery: 1 });
    expect(mapYnabCadence(99, 1)).toEqual({ cadence: "none", cadenceEvery: 1 });
    expect(periodMonths({ cadence: "yearly", cadenceEvery: 2, targetDate: null })).toBe(24);
  });

  it("maps goal types", () => {
    const base = { id: "c1", goal_target: 123450, goal_creation_month: "2025-06-01", goal_cadence: 1, goal_cadence_frequency: 1, goal_day: null };
    expect(mapYnabGoal({ ...base, goal_type: "NEED", goal_needs_whole_amount: true })).toMatchObject({ type: "need_set_aside", amount: 123450n, effectiveFrom: "2025-06-01", cadence: "monthly" });
    expect(mapYnabGoal({ ...base, goal_type: "NEED", goal_needs_whole_amount: false })!.type).toBe("need_refill");
    expect(mapYnabGoal({ ...base, goal_type: "NEED", goal_needs_whole_amount: null })!.type).toBe("need_refill");
    expect(mapYnabGoal({ ...base, goal_type: "TB" })!.type).toBe("balance");
    expect(mapYnabGoal({ ...base, goal_type: "TBD", goal_target_date: "2027-01-01" })).toMatchObject({ type: "balance_by_date", targetDate: "2027-01-01" });
    expect(mapYnabGoal({ ...base, goal_type: "MF", goal_cadence: 0 })).toMatchObject({ type: "monthly_builder", cadence: "monthly" });
    expect(mapYnabGoal({ ...base, goal_type: "DEBT", goal_cadence: null })).toMatchObject({ type: "debt", cadence: "monthly" });
    expect(mapYnabGoal({ ...base, goal_type: null })).toBeNull();
    expect(mapYnabGoal({ ...base, goal_type: "WEIRD" })).toBeNull();
    expect(mapYnabGoal({ ...base, goal_type: "NEED", goal_needs_whole_amount: true, goal_cadence: 0 })!.cadence).toBe("monthly");
    expect(mapYnabGoal({ ...base, goal_type: "NEED", goal_cadence: 0, goal_target_date: "2026-12-01" })!.cadence).toBe("none");
    expect(mapYnabGoal({ id: "c2", goal_type: "MF" }, "2026-01-01")).toMatchObject({ effectiveFrom: "2026-01-01", amount: 0n });
    expect(mapYnabGoal({ id: "c3", goal_type: "MF" })!.effectiveFrom).toBe("1970-01-01");
  });

  it("snooze maps to the local month of goal_snoozed_at", () => {
    expect(mapYnabGoal({ id: "c", goal_type: "MF", goal_target: 1, goal_snoozed_at: "2026-11-01T02:00:00Z" })!.snoozedMonth).toBe("2026-10-01");
    expect(mapYnabGoal({ id: "c", goal_type: "MF", goal_target: 1, goal_snoozed_at: "2026-10-05" })!.snoozedMonth).toBe("2026-10-01");
  });
});
