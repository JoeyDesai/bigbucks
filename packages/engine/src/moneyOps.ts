/**
 * Pure money operations (§6.8): assign, move money (category↔category, category↔RTA), and their
 * inverses for undo. Every operation returns a list of AssignmentChange; the caller persists them
 * (budget_operations.payload) and stores `invertChanges(changes)` as the inverse.
 * Ready to Assign is not stored: it moves implicitly by −Σ(to − from).
 */
import { evalAmountExpr } from "@homebase/shared";
import type { AssignmentChange, EngineAssignment, Milli, MoneyEndpoint, Month } from "./types";

export const RTA: MoneyEndpoint = "rta";

export type AssignmentSource = readonly EngineAssignment[] | ((month: Month, categoryId: string) => Milli);

export function getAssigned(src: AssignmentSource, month: Month, categoryId: string): Milli {
  if (typeof src === "function") return src(month, categoryId);
  let s = 0n;
  for (const a of src) if (a.month === month && a.categoryId === categoryId) s += a.assigned;
  return s;
}

/** Set Assigned(category, month) to `to`. */
export function assign(src: AssignmentSource, p: { month: Month; categoryId: string; to: Milli }): AssignmentChange[] {
  const from = getAssigned(src, p.month, p.categoryId);
  return from === p.to ? [] : [{ month: p.month, categoryId: p.categoryId, from, to: p.to }];
}

/** Evaluate the Assigned-cell mini-language ("+50", "=200", "*2", …) against the current value. */
export function assignExpression(src: AssignmentSource, p: { month: Month; categoryId: string; expr: string }): AssignmentChange[] {
  const from = getAssigned(src, p.month, p.categoryId);
  return assign(src, { month: p.month, categoryId: p.categoryId, to: evalAmountExpr(p.expr, from) });
}

/**
 * Move `amount` (> 0) from one endpoint to another in `month`.
 *  - category → category: from.assigned −= amount, to.assigned += amount
 *  - RTA → category: to.assigned += amount
 *  - category → RTA: from.assigned −= amount
 */
export function moveMoney(src: AssignmentSource, p: { month: Month; from: MoneyEndpoint; to: MoneyEndpoint; amount: Milli }): AssignmentChange[] {
  if (p.amount <= 0n) throw new Error("moveMoney: amount must be positive");
  if (p.from === p.to) throw new Error("moveMoney: from and to must differ");
  const out: AssignmentChange[] = [];
  if (p.from !== RTA) {
    const f = getAssigned(src, p.month, p.from);
    out.push({ month: p.month, categoryId: p.from, from: f, to: f - p.amount });
  }
  if (p.to !== RTA) {
    const t = getAssigned(src, p.month, p.to);
    out.push({ month: p.month, categoryId: p.to, from: t, to: t + p.amount });
  }
  return out;
}

/** Undo: the inverse change list (reverse order, from/to swapped). */
export function invertChanges(changes: readonly AssignmentChange[]): AssignmentChange[] {
  return [...changes].reverse().map((c) => ({ month: c.month, categoryId: c.categoryId, from: c.to, to: c.from }));
}

/** Coalesce several changes to the same cell into one (first `from`, last `to`); drops no-ops. */
export function mergeChanges(changes: readonly AssignmentChange[]): AssignmentChange[] {
  const map = new Map<string, AssignmentChange>();
  for (const c of changes) {
    const k = `${c.month}|${c.categoryId}`;
    const prev = map.get(k);
    map.set(k, prev ? { ...prev, to: c.to } : { ...c });
  }
  return [...map.values()].filter((c) => c.from !== c.to);
}

/**
 * Apply changes to an assignment list, returning a new list (input untouched). Throws if a change's
 * `from` does not match the current value (stale undo) unless `force` is set.
 */
export function applyChanges(assignments: readonly EngineAssignment[], changes: readonly AssignmentChange[], opts: { force?: boolean } = {}): EngineAssignment[] {
  const map = new Map<string, EngineAssignment>();
  for (const a of assignments) {
    const k = `${a.month}|${a.categoryId}`;
    const prev = map.get(k);
    map.set(k, prev ? { ...prev, assigned: prev.assigned + a.assigned } : { ...a });
  }
  for (const c of changes) {
    const k = `${c.month}|${c.categoryId}`;
    const cur = map.get(k)?.assigned ?? 0n;
    if (!opts.force && cur !== c.from) throw new Error(`stale change for ${k}: expected ${c.from}, found ${cur}`);
    map.set(k, { month: c.month, categoryId: c.categoryId, assigned: c.to });
  }
  return [...map.values()];
}

/** Effect of a change list on Ready to Assign (for the month and all later months). */
export function rtaDelta(changes: readonly AssignmentChange[]): Milli {
  let d = 0n;
  for (const c of changes) d -= c.to - c.from;
  return d;
}
