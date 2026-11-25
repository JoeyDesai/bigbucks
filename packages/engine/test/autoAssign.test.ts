import { describe, expect, it } from "vitest";
import { autoAssign, eligibleCategories } from "../src/autoAssign";
import { computeBudget } from "../src/budget";
import { applyChanges } from "../src/moneyOps";
import { $, c, pay, snap } from "./helpers";

const M = "2026-03-01";

function base() {
  return snap()
    .account("chk")
    .card("visa")
    .group("g-hidden", 9, true)
    .cat("rent")
    .cat("groc")
    .cat("fun")
    .cat("secret", { hidden: true })
    .cat("ingroup", { groupId: "g-hidden" })
    .income("chk", "2026-01-01", 10000);
}

describe("§6.6 auto-assign: simple modes", () => {
  it("assigned last month", () => {
    const s = base().assign("2026-02", "rent", 1500).assign("2026-02", "groc", 400).assign("2026-03", "groc", 100).build();
    const ch = autoAssign(s, { month: M, mode: "assigned_last_month" });
    expect(ch).toEqual([
      { month: M, categoryId: "rent", from: 0n, to: $(1500) },
      { month: M, categoryId: "groc", from: $(100), to: $(400) },
    ]);
  });

  it("spent last month (net outflow, never negative)", () => {
    const s = base().spend("chk", "2026-02-05", "groc", 320).tx({ acct: "chk", date: "2026-02-06", amt: 50, cat: "fun" }).build();
    const ch = autoAssign(s, { month: M, mode: "spent_last_month" });
    expect(ch).toEqual([{ month: M, categoryId: "groc", from: 0n, to: $(320) }]);
  });

  it("average assigned: from the first month with an assignment, last 12 months, excl. current", () => {
    const b = base().assign("2025-12", "groc", 300).assign("2026-01", "groc", 400).assign("2026-02", "groc", 0).assign("2026-03", "groc", 999);
    const ch = autoAssign(b.build(), { month: M, mode: "average_assigned" });
    // Dec 300, Jan 400, Feb 0 → 233.333 → 233.33
    expect(ch).toEqual([{ month: M, categoryId: "groc", from: $(999), to: $(233.33) }]);
  });

  it("average spent", () => {
    const b = base().spend("chk", "2026-01-05", "groc", 100).spend("chk", "2026-02-05", "groc", 200);
    expect(autoAssign(b.build(), { month: M, mode: "average_spent" })).toEqual([{ month: M, categoryId: "groc", from: 0n, to: $(150) }]);
  });

  it("reset assigned and reset available", () => {
    const s = base().assign("2026-02", "fun", 100).assign("2026-03", "fun", 50).spend("chk", "2026-03-02", "fun", 30).assign("2026-03", "groc", 20).spend("chk", "2026-03-02", "groc", 50).build();
    expect(autoAssign(s, { month: M, mode: "reset_assigned" })).toEqual([
      { month: M, categoryId: "groc", from: $(20), to: 0n },
      { month: M, categoryId: "fun", from: $(50), to: 0n },
    ]);
    // fun available = 100 + 50 − 30 = 120 → assigned 50 − 120 = −70; groc is overspent → untouched
    expect(autoAssign(s, { month: M, mode: "reset_available" })).toEqual([{ month: M, categoryId: "fun", from: $(50), to: $(-70) }]);
  });

  it("reduce overfunding: only categories with targets/upcoming, never below zero available", () => {
    const s = base()
      .target({ categoryId: "groc", type: "need_set_aside", amount: $(400) })
      .target({ categoryId: "fun", type: "need_refill", amount: $(100), snoozedMonth: M })
      .assign("2026-03", "groc", 600)
      .spend("chk", "2026-03-03", "groc", 500)
      .assign("2026-02", "fun", 80)
      .assign("2026-03", "fun", 70)
      .assign("2026-03", "rent", 999)
      .build();
    const ch = autoAssign(s, { month: M, mode: "reduce_overfunding" });
    // groc: over 200 but available only 100 → reduce 100; fun: refill needs 20 (snoozed but still counted), over 50
    expect(ch).toEqual([
      { month: M, categoryId: "groc", from: $(600), to: $(500) },
      { month: M, categoryId: "fun", from: $(70), to: $(20) },
    ]);
  });

  it("selection limits the categories; hidden ones are skipped when nothing is selected", () => {
    const s = base().assign("2026-02", "secret", 10).assign("2026-02", "ingroup", 10).assign("2026-02", "groc", 10).build();
    expect(autoAssign(s, { month: M, mode: "assigned_last_month" }).map((x) => x.categoryId)).toEqual(["groc"]);
    expect(autoAssign(s, { month: M, mode: "assigned_last_month", selection: ["secret"] }).map((x) => x.categoryId)).toEqual(["secret"]);
    expect(eligibleCategories(s).map((x) => x.id)).toEqual([pay("visa"), "rent", "groc", "fun"]);
  });

  it("returns nothing for a month the engine did not produce", () => {
    const s = base().build();
    const pre = computeBudget(s, { through: "2026-01-01" });
    expect(autoAssign(s, { month: "2026-01-01", mode: "reset_assigned" }, pre)).toEqual([]);
    expect(autoAssign(s, { month: "2026-01-01", mode: "reset_assigned", budget: { through: "2026-02-01", from: "2026-02-01" } })).toEqual([]);
  });
});

describe("§6.6 auto-assign: underfunded", () => {
  const scenario = () =>
    base()
      .target({ categoryId: "rent", type: "monthly_builder", amount: $(1500) })
      .target({ categoryId: "groc", type: "need_set_aside", amount: $(400) })
      .scheduled({ accountId: "chk", categoryId: "fun", amount: $(-60), frequency: "monthly", nextDate: "2026-03-20" })
      .spend("chk", "2026-03-02", "fun", 25) // fun overspent by 25 (cash) — schedule need 60 + 25
      .spend("visa", "2026-02-10", "groc", 300); // Feb credit overspending → P(K) underfunded 300

  it("funds targets, then upcoming, then overspending, then card payments (spec order)", () => {
    const s = scenario().build();
    const ch = autoAssign(s, { month: M, mode: "underfunded" });
    expect(ch).toEqual([
      { month: M, categoryId: "rent", from: 0n, to: $(1500) },
      { month: M, categoryId: "groc", from: 0n, to: $(400) },
      { month: M, categoryId: "fun", from: 0n, to: $(85) },
      { month: M, categoryId: pay("visa"), from: 0n, to: $(300) },
    ]);
    const after = computeBudget({ ...s, assignments: applyChanges(s.assignments, ch) }, { through: M });
    for (const id of ["rent", "groc", "fun", pay("visa")]) expect(c(after, M, id).underfunded).toBe(0n);
    expect(c(after, M, "fun").available).toBe($(60));
  });

  it("caps at Ready to Assign when nothing is selected (partial last category)", () => {
    const s = scenario().build();
    s.transactions[0]!.amount = $(1700); // RTA ≈ 1700 − Feb nothing assigned
    const ch = autoAssign(s, { month: M, mode: "underfunded" });
    const total = ch.reduce((a, x) => a + (x.to - x.from), 0n);
    expect(total).toBe($(1700));
    expect(ch.map((x) => x.categoryId)).toEqual(["rent", "groc"]);
    expect(ch[1]!.to).toBe($(200));
  });

  it("does nothing when RTA is not positive (no selection)", () => {
    const s = scenario().build();
    s.transactions[0]!.amount = 0n;
    expect(autoAssign(s, { month: M, mode: "underfunded" })).toEqual([]);
  });

  it("with a selection, funds fully even past RTA", () => {
    const s = scenario().build();
    s.transactions[0]!.amount = $(100);
    expect(autoAssign(s, { month: M, mode: "underfunded", selection: ["rent"] })).toEqual([{ month: M, categoryId: "rent", from: 0n, to: $(1500) }]);
    expect(autoAssign(s, { month: M, mode: "underfunded", selection: ["rent"], capToRta: true })).toEqual([{ month: M, categoryId: "rent", from: 0n, to: $(100) }]);
  });

  it("covering credit overspending this month reduces what P(K) needs (no double funding)", () => {
    const s = base().spend("visa", "2026-03-05", "groc", 80).build();
    const ch = autoAssign(s, { month: M, mode: "underfunded" });
    expect(ch).toEqual([{ month: M, categoryId: "groc", from: 0n, to: $(80) }]);
  });

  it("YNAB order: overspending, then dated, then end of month, then future", () => {
    const s = base()
      .cat("insurance")
      .cat("netflix")
      .target({ categoryId: "rent", type: "monthly_builder", amount: $(100) }) // end of month
      .target({ categoryId: "groc", type: "need_set_aside", amount: $(100), day: 20 }) // dated 20th
      .target({ categoryId: "insurance", type: "need_set_aside", amount: $(1200), cadence: "yearly", targetDate: "2026-12-01" }) // future
      .target({ categoryId: "secret", type: "balance", amount: $(50) }) // ignored (hidden, and TB w/o date)
      .target({ categoryId: "netflix", type: "balance", amount: $(50) }) // TB w/o date → skipped in ynab order
      .scheduled({ accountId: "chk", categoryId: "fun", amount: $(-30), frequency: "monthly", nextDate: "2026-03-05" }) // dated 5th
      .spend("chk", "2026-03-01", "netflix", 10) // overspent → first
      .build();
    const ch = autoAssign(s, { month: M, mode: "underfunded", order: "ynab" });
    expect(ch.map((x) => [x.categoryId, x.to])).toEqual([
      ["netflix", $(50)],
      ["fun", $(30)],
      ["groc", $(100)],
      ["rent", $(100)],
      ["insurance", $(120)],
    ]);
  });

  it("YNAB order: a weekly target due before a scheduled transaction wins", () => {
    const s = base()
      .target({ categoryId: "groc", type: "need_set_aside", amount: $(10), cadence: "weekly", day: 0 }) // first Sunday 2026-03-01
      .target({ categoryId: "fun", type: "need_set_aside", amount: $(10), day: 3 })
      .scheduled({ accountId: "chk", categoryId: "fun", amount: $(-50), frequency: "monthly", nextDate: "2026-03-28" })
      .target({ categoryId: "rent", type: "need_set_aside", amount: $(10), snoozedMonth: M })
      .build();
    const ch = autoAssign(s, { month: M, mode: "underfunded", order: "ynab" });
    expect(ch.map((x) => x.categoryId)).toEqual(["groc", "fun"]);
    expect(ch[1]!.to).toBe($(50));
  });

  it("accepts a precomputed result", () => {
    const s = scenario().build();
    const pre = computeBudget(s, { through: M });
    expect(autoAssign(s, { month: M, mode: "underfunded" }, pre)).toEqual(autoAssign(s, { month: M, mode: "underfunded" }));
  });
});
