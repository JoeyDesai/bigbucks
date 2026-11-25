/** Pure budget-view transforms for optimistic UI. The server remains the source of truth. */
import type { GroupVM } from "./view-models";

export type PlanFilter = "all" | "overspent" | "underfunded" | "overfunded" | "available" | "snoozed";

export interface PlanState {
  groups: GroupVM[];
  readyToAssign: bigint;
}

/** Set Assigned for one category: Available moves by the same delta, RTA by the opposite. */
export function applyAssign(state: PlanState, categoryId: string, next: bigint): PlanState {
  let delta = 0n;
  const groups = state.groups.map((g) => ({
    ...g,
    categories: g.categories.map((c) => {
      if (c.id !== categoryId) return c;
      delta = next - c.assigned;
      const underfunded = c.target ? maxB(c.target.underfunded - delta, 0n) : 0n;
      return { ...c, assigned: next, available: c.available + delta, target: c.target ? { ...c.target, underfunded } : null };
    }),
  }));
  return { groups, readyToAssign: state.readyToAssign - delta };
}

/** Move money between two categories, or to/from Ready to Assign with id "rta". */
export function applyMove(state: PlanState, fromId: string, toId: string, amount: bigint): PlanState {
  let s = state;
  const assigned = (id: string) => s.groups.flatMap((g) => g.categories).find((c) => c.id === id)?.assigned;
  if (fromId !== "rta") {
    const a = assigned(fromId);
    if (a !== undefined) s = applyAssign(s, fromId, a - amount);
  }
  if (toId !== "rta") {
    const a = assigned(toId);
    if (a !== undefined) s = applyAssign(s, toId, a + amount);
  }
  return s;
}

/** Auto-Assign "Underfunded": fund every underfunded target (optionally limited to ids). */
export function applyFundUnderfunded(state: PlanState, ids?: string[]): { state: PlanState; total: bigint; count: number } {
  let s = state;
  let total = 0n;
  let count = 0;
  for (const c of state.groups.flatMap((g) => g.categories)) {
    if (ids && !ids.includes(c.id)) continue;
    const u = c.target && !c.target.snoozed ? c.target.underfunded : 0n;
    if (u > 0n) {
      s = applyAssign(s, c.id, c.assigned + u);
      total += u;
      count++;
    }
  }
  return { state: s, total, count };
}

export function matchesFilter(c: GroupVM["categories"][number], f: PlanFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "overspent":
      return c.available < 0n;
    case "underfunded":
      return !!c.target && !c.target.snoozed && c.target.underfunded > 0n;
    case "overfunded":
      return !!c.target && c.target.needed > 0n && c.assigned > c.target.needed;
    case "available":
      return c.available > 0n;
    case "snoozed":
      return !!c.target?.snoozed;
  }
}

function maxB(a: bigint, b: bigint) {
  return a > b ? a : b;
}

/** Optimistic actions for `useOptimistic` on the Plan screen. */
export type PlanAction =
  | { type: "assign"; categoryId: string; value: bigint }
  | { type: "move"; from: string; to: string; amount: bigint }
  | { type: "fund_underfunded"; categoryIds?: string[] };

export function planReducer(state: PlanState, a: PlanAction): PlanState {
  switch (a.type) {
    case "assign":
      return applyAssign(state, a.categoryId, a.value);
    case "move":
      return applyMove(state, a.from, a.to, a.amount);
    case "fund_underfunded":
      return applyFundUnderfunded(state, a.categoryIds).state;
  }
}
