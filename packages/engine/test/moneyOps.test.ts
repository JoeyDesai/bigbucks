import { describe, expect, it } from "vitest";
import { computeBudget } from "../src/budget";
import { applyChanges, assign, assignExpression, getAssigned, invertChanges, mergeChanges, moveMoney, RTA, rtaDelta } from "../src/moneyOps";
import type { EngineAssignment } from "../src/types";
import { $, c, m, snap } from "./helpers";

const M = "2026-03-01";
const A: EngineAssignment[] = [
  { month: M, categoryId: "a", assigned: $(100) },
  { month: M, categoryId: "b", assigned: $(50) },
  { month: "2026-02-01", categoryId: "a", assigned: $(7) },
];

describe("§6.8 money operations", () => {
  it("getAssigned from a list or a lookup", () => {
    expect(getAssigned(A, M, "a")).toBe($(100));
    expect(getAssigned(A, M, "zzz")).toBe(0n);
    expect(getAssigned(() => 5n, M, "a")).toBe(5n);
  });

  it("assign sets a value; no-op returns nothing", () => {
    expect(assign(A, { month: M, categoryId: "a", to: $(120) })).toEqual([{ month: M, categoryId: "a", from: $(100), to: $(120) }]);
    expect(assign(A, { month: M, categoryId: "a", to: $(100) })).toEqual([]);
  });

  it("assignExpression uses the Assigned-cell mini-language", () => {
    expect(assignExpression(A, { month: M, categoryId: "a", expr: "+50" })[0]!.to).toBe($(150));
    expect(assignExpression(A, { month: M, categoryId: "b", expr: "*2" })[0]!.to).toBe($(100));
    expect(assignExpression(A, { month: M, categoryId: "b", expr: "=25" })[0]!.to).toBe($(25));
  });

  it("move category → category", () => {
    const ch = moveMoney(A, { month: M, from: "a", to: "b", amount: $(30) });
    expect(ch).toEqual([
      { month: M, categoryId: "a", from: $(100), to: $(70) },
      { month: M, categoryId: "b", from: $(50), to: $(80) },
    ]);
    expect(rtaDelta(ch)).toBe(0n);
  });

  it("move RTA → category and category → RTA", () => {
    const inCh = moveMoney(A, { month: M, from: RTA, to: "c", amount: $(10) });
    expect(inCh).toEqual([{ month: M, categoryId: "c", from: 0n, to: $(10) }]);
    expect(rtaDelta(inCh)).toBe($(-10));
    const outCh = moveMoney(A, { month: M, from: "a", to: RTA, amount: $(10) });
    expect(outCh).toEqual([{ month: M, categoryId: "a", from: $(100), to: $(90) }]);
    expect(rtaDelta(outCh)).toBe($(10));
  });

  it("rejects bad moves", () => {
    expect(() => moveMoney(A, { month: M, from: "a", to: "b", amount: 0n })).toThrow();
    expect(() => moveMoney(A, { month: M, from: "a", to: "a", amount: 1n })).toThrow();
  });

  it("invert + apply is an exact undo", () => {
    const ch = moveMoney(A, { month: M, from: "a", to: "b", amount: $(30) });
    const after = applyChanges(A, ch);
    expect(getAssigned(after, M, "a")).toBe($(70));
    const undone = applyChanges(after, invertChanges(ch));
    expect(getAssigned(undone, M, "a")).toBe($(100));
    expect(getAssigned(undone, M, "b")).toBe($(50));
    expect(getAssigned(undone, "2026-02-01", "a")).toBe($(7));
  });

  it("applyChanges detects stale changes unless forced, and merges duplicate rows", () => {
    const stale = [{ month: M, categoryId: "a", from: $(1), to: $(2) }];
    expect(() => applyChanges(A, stale)).toThrow(/stale/);
    expect(getAssigned(applyChanges(A, stale, { force: true }), M, "a")).toBe($(2));
    const dup = applyChanges([...A, { month: M, categoryId: "a", assigned: $(1) }], []);
    expect(getAssigned(dup, M, "a")).toBe($(101));
  });

  it("mergeChanges coalesces and drops no-ops", () => {
    expect(
      mergeChanges([
        { month: M, categoryId: "a", from: 1n, to: 2n },
        { month: M, categoryId: "a", from: 2n, to: 3n },
        { month: M, categoryId: "b", from: 1n, to: 2n },
        { month: M, categoryId: "b", from: 2n, to: 1n },
      ]),
    ).toEqual([{ month: M, categoryId: "a", from: 1n, to: 3n }]);
  });

  it("moving money changes the engine's RTA and Available as expected", () => {
    const b = snap().account("chk").cat("a").cat("b").income("chk", "2026-03-01", 1000).assign("2026-03", "a", 300);
    const s = b.build();
    const ch = moveMoney(s.assignments, { month: M, from: "a", to: RTA, amount: $(100) });
    const r = computeBudget({ ...s, assignments: applyChanges(s.assignments, ch) }, { through: M });
    expect(m(r, M).rta).toBe($(800));
    expect(c(r, M, "a").available).toBe($(200));
  });
});
