import { describe, expect, it } from "vitest";
import { applyAssign, applyFundUnderfunded, applyMove, matchesFilter } from "./plan-state";
import type { CategoryVM, GroupVM } from "./view-models";

const c = (id: string, o: Partial<CategoryVM> = {}): CategoryVM => ({ id, groupId: "g", name: id, kind: "normal", assigned: 100_000n, activity: 0n, available: 100_000n, target: null, ...o });
const state = () => ({
  readyToAssign: 500_000n,
  groups: [{ id: "g", name: "G", categories: [c("a"), c("b", { target: { type: "need_set_aside", description: "", amount: 300_000n, needed: 300_000n, underfunded: 200_000n } })] }] as GroupVM[],
});
const get = (s: ReturnType<typeof state>, id: string) => s.groups[0]!.categories.find((x) => x.id === id)!;

describe("plan-state", () => {
  it("assign moves Available and RTA by the delta", () => {
    const s = applyAssign(state(), "a", 150_000n);
    expect(get(s, "a").available).toBe(150_000n);
    expect(s.readyToAssign).toBe(450_000n);
  });
  it("assign reduces underfunded", () => {
    const s = applyAssign(state(), "b", 250_000n);
    expect(get(s, "b").target!.underfunded).toBe(50_000n);
  });
  it("move between categories leaves RTA unchanged", () => {
    const s = applyMove(state(), "a", "b", 40_000n);
    expect(get(s, "a").available).toBe(60_000n);
    expect(get(s, "b").available).toBe(140_000n);
    expect(s.readyToAssign).toBe(500_000n);
  });
  it("move to and from RTA", () => {
    expect(applyMove(state(), "a", "rta", 10_000n).readyToAssign).toBe(510_000n);
    expect(applyMove(state(), "rta", "a", 10_000n).readyToAssign).toBe(490_000n);
  });
  it("fund underfunded", () => {
    const r = applyFundUnderfunded(state());
    expect(r.total).toBe(200_000n);
    expect(r.count).toBe(1);
    expect(r.state.readyToAssign).toBe(300_000n);
  });
  it("filters", () => {
    expect(matchesFilter(c("x", { available: -1n }), "overspent")).toBe(true);
    expect(matchesFilter(c("x"), "available")).toBe(true);
    expect(matchesFilter(c("x"), "snoozed")).toBe(false);
  });
});

describe("planReducer", () => {
  it("dispatches assign / move / fund", async () => {
    const { planReducer } = await import("./plan-state");
    expect(planReducer(state(), { type: "assign", categoryId: "a", value: 0n }).readyToAssign).toBe(600_000n);
    expect(planReducer(state(), { type: "move", from: "a", to: "b", amount: 1n }).readyToAssign).toBe(500_000n);
    expect(planReducer(state(), { type: "fund_underfunded" }).readyToAssign).toBe(300_000n);
  });
});
