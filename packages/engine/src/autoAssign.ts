/**
 * Auto-Assign (§6.6). Pure: returns the assignment changes; the caller applies them as a single
 * undoable operation (store `invertChanges(changes)` as the inverse).
 */
import { addMonths, divRound } from "@homebase/shared";
import { computeBudget, orderedBudgetCategories } from "./budget";
import { applyChanges, mergeChanges } from "./moneyOps";
import { occurrencesInMonth } from "./schedule";
import { computeTargetMonth, effectiveTarget, indexTargets, targetDue, type TargetMonth } from "./targets";
import type { AssignmentChange, AutoAssignOptions, BudgetOptions, BudgetResult, BudgetSnapshot, CategoryMonth, EngineCategory, ISODate, Milli, Month, MonthResult } from "./types";

const max0 = (a: Milli): Milli => (a > 0n ? a : 0n);
const toCents = (m: Milli): Milli => divRound(m, 10n) * 10n;

function budgetOptions(o: AutoAssignOptions): BudgetOptions {
  const through = o.budget?.through && o.budget.through > o.month ? o.budget.through : o.month;
  return { ...o.budget, through };
}

/** Recompute the target figures for a category month (so callers can see each component). */
function targetParts(snapshot: BudgetSnapshot, result: BudgetResult, mr: MonthResult, c: EngineCategory, cm: CategoryMonth, targets: ReturnType<typeof indexTargets>): TargetMonth {
  return computeTargetMonth({
    month: mr.month,
    kind: c.kind,
    target: effectiveTarget(targets.get(c.id), mr.month),
    carryIn: cm.carryIn,
    assigned: cm.assigned,
    activity: cm.activity,
    assignedIn: (m) => result.months[m]?.categories[c.id]?.assigned ?? snapshot.assignments.filter((a) => a.month === m && a.categoryId === c.id).reduce((s, a) => s + a.assigned, 0n),
    income: mr.income,
    incomeOverrides: snapshot.incomeBasis,
    upcoming: cm.upcoming,
    debt: cm.payment?.debt,
  });
}

/** Categories auto-assign acts on: the selection, or all visible (non-hidden, non-deleted) ones. */
export function eligibleCategories(snapshot: BudgetSnapshot, selection?: string[]): EngineCategory[] {
  const groups = new Map(snapshot.groups.map((g) => [g.id, g]));
  const cats = orderedBudgetCategories(snapshot).filter((c) => c.kind === "normal" || c.kind === "cc_payment");
  if (selection && selection.length > 0) {
    const sel = new Set(selection);
    return cats.filter((c) => sel.has(c.id));
  }
  return cats.filter((c) => !c.hidden && !c.deleted && !groups.get(c.groupId)?.hidden);
}

function earliestUpcoming(snapshot: BudgetSnapshot, month: Month): Map<string, ISODate> {
  const out = new Map<string, ISODate>();
  for (const s of snapshot.scheduled) {
    if (s.deleted) continue;
    const first = occurrencesInMonth(s, month)[0];
    if (!first) continue;
    const parts = s.splits && s.splits.length ? s.splits : [{ categoryId: s.categoryId, amount: s.amount }];
    for (const p of parts) {
      if (!p.categoryId || p.amount >= 0n) continue;
      const prev = out.get(p.categoryId);
      if (!prev || first < prev) out.set(p.categoryId, first);
    }
  }
  return out;
}

/**
 * Compute auto-assign changes for `opts.month`.
 * `precomputed` may be passed to avoid re-running the engine (it must include `opts.month`).
 */
export function autoAssign(snapshot: BudgetSnapshot, opts: AutoAssignOptions, precomputed?: BudgetResult): AssignmentChange[] {
  const bopts = budgetOptions(opts);
  const result = precomputed && precomputed.months[opts.month] ? precomputed : computeBudget(snapshot, bopts);
  const M = opts.month;
  const mr = result.months[M];
  if (!mr) return [];
  const cats = eligibleCategories(snapshot, opts.selection);
  const hasSelection = !!opts.selection && opts.selection.length > 0;
  const cap = opts.capToRta ?? !hasSelection;
  const cmOf = (c: EngineCategory): CategoryMonth | undefined => mr.categories[c.id];
  const change = (c: EngineCategory, to: Milli): AssignmentChange | null => {
    const cm = cmOf(c);
    const from = cm?.assigned ?? 0n;
    return to === from ? null : { month: M, categoryId: c.id, from, to };
  };
  const collect = (f: (c: EngineCategory, cm: CategoryMonth) => Milli | null): AssignmentChange[] => {
    const out: AssignmentChange[] = [];
    for (const c of cats) {
      const cm = cmOf(c);
      if (!cm) continue;
      const to = f(c, cm);
      if (to === null) continue;
      const ch = change(c, to);
      if (ch) out.push(ch);
    }
    return out;
  };
  const history = (n: number): MonthResult[] => {
    const out: MonthResult[] = [];
    for (let i = n; i >= 1; i--) {
      const r = result.months[addMonths(M, -i)];
      if (r) out.push(r);
    }
    return out;
  };

  switch (opts.mode) {
    case "assigned_last_month":
      return collect((c) => result.months[addMonths(M, -1)]?.categories[c.id]?.assigned ?? 0n);
    case "spent_last_month":
      return collect((c) => max0(-(result.months[addMonths(M, -1)]?.categories[c.id]?.activity ?? 0n)));
    case "average_assigned":
      return collect((c) => {
        const h = history(12).map((r) => r.categories[c.id]?.assigned ?? 0n);
        const start = h.findIndex((x) => x !== 0n);
        if (start < 0) return null;
        const xs = h.slice(start);
        return toCents(divRound(xs.reduce((a, b) => a + b, 0n), BigInt(xs.length)));
      });
    case "average_spent":
      return collect((c) => {
        const h = history(12).map((r) => r.categories[c.id]);
        const start = h.findIndex((x) => !!x && (x.assigned !== 0n || x.activity !== 0n));
        if (start < 0) return null;
        const xs = h.slice(start).map((x) => -(x?.activity ?? 0n));
        return max0(toCents(divRound(xs.reduce((a, b) => a + b, 0n), BigInt(xs.length))));
      });
    case "reset_assigned":
      return collect(() => 0n);
    case "reset_available":
      return collect((_c, cm) => (cm.available > 0n ? cm.assigned - cm.available : null));
    case "reduce_overfunding": {
      const targets = indexTargets(snapshot.targets);
      return collect((c, cm) => {
        if (!cm.hasTarget && cm.upcoming === 0n) return null;
        const t = targetParts(snapshot, result, mr, c, cm, targets);
        const over = max0(cm.assigned - t.neededUnsnoozed);
        const reduce = over < max0(cm.available) ? over : max0(cm.available);
        return reduce > 0n ? cm.assigned - reduce : null;
      });
    }
    case "underfunded":
      return underfunded(snapshot, opts, bopts, result, mr, cats, cap);
  }
}

function underfunded(snapshot: BudgetSnapshot, opts: AutoAssignOptions, bopts: BudgetOptions, result: BudgetResult, mr: MonthResult, cats: EngineCategory[], cap: boolean): AssignmentChange[] {
  const M = mr.month;
  const targets = indexTargets(snapshot.targets);
  let remaining = cap ? mr.readyToAssignDisplay : null;
  if (remaining !== null && remaining <= 0n) return [];
  const added = new Map<string, Milli>();
  const changes: AssignmentChange[] = [];
  const give = (c: EngineCategory, want: Milli) => {
    if (want <= 0n) return;
    if (remaining !== null) {
      if (remaining <= 0n) return;
      if (want > remaining) want = remaining;
      remaining -= want;
    }
    const base = (mr.categories[c.id]?.assigned ?? 0n) + (added.get(c.id) ?? 0n);
    added.set(c.id, (added.get(c.id) ?? 0n) + want);
    changes.push({ month: M, categoryId: c.id, from: base, to: base + want });
  };
  const nonCc = cats.filter((c) => c.kind !== "cc_payment");
  const cc = cats.filter((c) => c.kind === "cc_payment");
  const parts = new Map<string, TargetMonth>();
  for (const c of cats) {
    const cm = mr.categories[c.id];
    if (cm) parts.set(c.id, targetParts(snapshot, result, mr, c, cm, targets));
  }
  const fullNeed = (c: EngineCategory): Milli => {
    const cm = mr.categories[c.id];
    const t = parts.get(c.id);
    if (!cm || !t) return 0n;
    const u = max0(t.needed - cm.assigned);
    const cover = max0(-cm.available);
    return (u > cover ? u : cover) - (added.get(c.id) ?? 0n);
  };

  if ((opts.order ?? "spec") === "spec") {
    // 1) targets in group/category sort order
    for (const c of cats) {
      const cm = mr.categories[c.id];
      const t = parts.get(c.id);
      if (!cm || !t || !cm.hasTarget) continue;
      give(c, max0(t.targetNeeded - cm.assigned));
    }
    // 2) upcoming scheduled transactions
    for (const c of cats) {
      const cm = mr.categories[c.id];
      const t = parts.get(c.id);
      if (!cm || !t || t.scheduleNeeded === 0n) continue;
      give(c, max0(t.scheduleNeeded - cm.assigned) - (added.get(c.id) ?? 0n));
    }
    // 3) overspending
    for (const c of nonCc) give(c, fullNeed(c));
  } else {
    // YNAB documented order
    const upcomingDate = earliestUpcoming(snapshot, M);
    type Item = { c: EngineCategory; rank: number; key: string; idx: number };
    const items: Item[] = [];
    nonCc.forEach((c, idx) => {
      const cm = mr.categories[c.id];
      const t = parts.get(c.id);
      if (!cm || !t) return;
      if (cm.available < 0n) return items.push({ c, rank: 0, key: "", idx });
      const target = effectiveTarget(targets.get(c.id), M);
      const due = target && !cm.snoozed ? targetDue(target, M) : { kind: "none" as const };
      const sched = upcomingDate.get(c.id);
      if (sched && (due.kind !== "dated" || sched < due.date)) return items.push({ c, rank: 1, key: sched, idx });
      switch (due.kind) {
        case "dated":
          return items.push({ c, rank: 1, key: due.date, idx });
        case "end_of_month":
          return items.push({ c, rank: 2, key: "", idx });
        case "future":
          return items.push({ c, rank: 3, key: due.month, idx });
        case "none":
          return;
      }
    });
    items.sort((a, b) => a.rank - b.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || a.idx - b.idx);
    for (const it of items) give(it.c, fullNeed(it.c));
  }

  // 4) credit card payment categories, re-evaluated after the spending categories were funded
  if (cc.length > 0 && (remaining === null || remaining > 0n)) {
    const merged = mergeChanges(changes);
    const snap2: BudgetSnapshot = merged.length ? { ...snapshot, assignments: applyChanges(snapshot.assignments, merged, { force: true }) } : snapshot;
    const r2 = merged.length ? computeBudget(snap2, bopts) : result;
    const mr2 = r2.months[M]!;
    for (const c of cc) {
      const cm = mr2.categories[c.id];
      if (!cm) continue;
      const t = targetParts(snap2, r2, mr2, c, cm, targets);
      const u = max0(t.needed - cm.assigned);
      const cover = max0(-cm.available);
      // mr2 already includes everything added so far, so this is the remaining need
      give(c, u > cover ? u : cover);
    }
  }
  return mergeChanges(changes);
}
