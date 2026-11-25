import { describe, expect, it } from "vitest";
import { parseMilli } from "@homebase/shared";
import { bucketBar } from "@homebase/core/buckets";
import { paceText, parseGoalText, rolloverText, rowDisplay } from "./bucket-display";

const $ = parseMilli;
const goal = (amount: bigint, kind: "monthly" | "balance" = "monthly") => ({ type: kind === "balance" ? ("balance" as const) : ("need_set_aside" as const), targetAmount: amount, amount, kind, cadence: "monthly" as const, label: "", simple: true });
const row = (budget: bigint | null, spent: bigint, o: { kind?: "monthly" | "balance"; available?: bigint } = {}) => {
  const bar = bucketBar(budget, spent);
  return { name: "Groceries", bar, budget, spent, remaining: bar.remaining, goal: budget ? goal(budget, o.kind) : null, available: o.available ?? 0n };
};

describe("rowDisplay", () => {
  it("under budget: what's left", () => {
    const d = rowDisplay(row($("950"), $("594")));
    expect(d).toMatchObject({ amount: $("356"), amountSuffix: "left", tone: "ink", detail: "$594 of $950 spent" });
    expect(d.bar.fill).toBeCloseTo(0.3747, 3);
  });
  it("amber from 85%, done when exactly spent", () => {
    expect(rowDisplay(row($("100"), $("90"))).tone).toBe("warn");
    expect(rowDisplay(row($("79.99"), $("79.99")))).toMatchObject({ done: true, tone: "muted", detail: "All $80 spent" });
  });
  it("over budget: red, how much over", () => {
    const d = rowDisplay(row($("320"), $("412")));
    expect(d).toMatchObject({ amount: $("92"), amountSuffix: "over", tone: "over" });
    expect(d.bar.over).toBeCloseTo(0.2875, 3);
  });
  it("no goal: spent only", () => {
    expect(rowDisplay(row(null, $("45")))).toMatchObject({ amount: $("45"), amountSuffix: "spent", bar: { state: "none" } });
  });
  it("savings goals show progress toward the balance", () => {
    const d = rowDisplay(row($("20000"), 0n, { kind: "balance", available: $("15000") }));
    expect(d).toMatchObject({ amount: $("15000"), amountSuffix: "saved", savings: true, detail: "75% of $20,000 goal" });
    expect(d.bar.fill).toBe(0.75);
  });
});

describe("overflow (rollover) rows", () => {
  const rolling = (goalAmount: bigint | null, carryIn: bigint, spent: bigint) => {
    const budget = goalAmount === null ? (carryIn > 0n ? carryIn : null) : goalAmount + carryIn;
    return { ...row(budget, spent), goal: goalAmount ? goal(goalAmount) : null, goalAmount, carryIn, rollover: true };
  };
  it("subtitle: goal + what rolled over; the bar measures against both", () => {
    const d = rowDisplay(rolling($("50"), $("175"), $("60")));
    expect(d.rollover).toBe("$50 goal + $175 rolled over");
    expect(d).toMatchObject({ amount: $("165"), amountSuffix: "left", detail: "$60 of $225 spent" });
    expect(d.bar.fill).toBeCloseTo(165 / 225, 3);
  });
  it("nothing carried yet, carry without a goal, and rollover off", () => {
    expect(rowDisplay(rolling($("100"), 0n, $("20"))).rollover).toBe("$100 goal, leftovers roll over");
    expect(rowDisplay(rolling(null, $("80"), $("30")))).toMatchObject({ rollover: "$80 rolled over", amount: $("50"), amountSuffix: "left" });
    expect(rowDisplay(row($("950"), $("594"))).rollover).toBeNull();
    expect(rolloverText({ rollover: false, carryIn: $("10"), goalAmount: $("50") })).toBeNull();
    expect(rolloverText({ rollover: true, carryIn: $("174.60"), goalAmount: $("50") })).toBe("$50 goal + $175 rolled over");
  });
  it("overspending a rolled-over budget is over the total", () => {
    expect(rowDisplay(rolling($("50"), $("25"), $("90")))).toMatchObject({ amount: $("15"), amountSuffix: "over", tone: "over", rollover: "$50 goal + $25 rolled over" });
  });
});

describe("goal text and pace", () => {
  it("parses dollar amounts", () => {
    expect(parseGoalText("950")).toBe($("950"));
    expect(parseGoalText("$1,200.50")).toBe($("1200.50"));
    expect(parseGoalText("0")).toBeNull();
    expect(parseGoalText("abc")).toBeNull();
    expect(parseGoalText("1.234")).toBeNull();
  });
  it("pace labels", () => {
    expect(paceText("ahead", 0.87, 0.74)).toEqual({ title: "Ahead of pace", detail: "87% spent with 74% of the month gone" });
    expect(paceText("behind", 0.3, 0.7).title).toBe("Under pace");
    expect(paceText("none", 0, 0).title).toBe("Month hasn't started");
  });
});
