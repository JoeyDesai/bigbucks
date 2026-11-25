/**
 * Targets (§6.5): needed(M) for every type and cadence, underfunded, overall left, % complete,
 * snooze, effective-from history, upcoming scheduled transactions, and percent-of-income.
 * Also the YNAB goal mapping used by the importer (§10).
 */
import { addMonths, monthOf, monthsBetween, weekday, daysInMonth, daysBetween, toLocalDate } from "@homebase/shared";
import type { Cadence, CategoryKind, TargetType } from "@homebase/shared";
import type { EngineTarget, IncomeBasisOverride, ISODate, Milli, Month } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Rounding helpers (bigint only)
// ─────────────────────────────────────────────────────────────────────────────

/** ceil(a / n) rounded UP to whole cents, for a ≥ 0. YNAB asks for at least enough to stay on track. */
export function ceilCentsDiv(a: Milli, n: bigint): Milli {
  if (a <= 0n) return 0n;
  const d = n * 10n;
  return ((a + d - 1n) / d) * 10n;
}

const PCT_SCALE = 1_000_000n;

/** Parse a decimal percent ("10", "12.5", 7.25) into an integer scaled by 1e6. */
export function parsePercent(p: string | number): bigint {
  const s = typeof p === "number" ? p.toFixed(6) : p.trim();
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new Error(`Invalid percent: ${p}`);
  const whole = BigInt(m[2] || "0");
  const frac = BigInt((m[3] ?? "").padEnd(6, "0").slice(0, 6));
  const v = whole * PCT_SCALE + frac;
  return m[1] === "-" ? -v : v;
}

/** basis × percent / 100, rounded half-up to whole cents. */
export function percentOf(basis: Milli, percent: string | number): Milli {
  const scaled = parsePercent(percent);
  const num = basis * scaled; // milli × pct×1e6
  const den = 100n * PCT_SCALE * 10n; // → cents
  const neg = num < 0n;
  const a = neg ? -num : num;
  const cents = (a * 2n + den) / (den * 2n);
  return (neg ? -cents : cents) * 10n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Target history
// ─────────────────────────────────────────────────────────────────────────────

/** Group targets by category, each list sorted by effectiveFrom ascending. */
export function indexTargets(targets: EngineTarget[]): Map<string, EngineTarget[]> {
  const map = new Map<string, EngineTarget[]>();
  for (const t of targets) {
    const list = map.get(t.categoryId) ?? [];
    list.push(t);
    map.set(t.categoryId, list);
  }
  for (const list of map.values()) list.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0));
  return map;
}

/** The target in effect for `month`: the latest row with effectiveFrom ≤ month (null if removed/none). */
export function effectiveTarget(rows: EngineTarget[] | undefined, month: Month): EngineTarget | null {
  if (!rows) return null;
  let found: EngineTarget | null = null;
  for (const r of rows) {
    if (r.effectiveFrom <= month) found = r;
    else break;
  }
  return found && !found.removed ? found : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cadence / periods
// ─────────────────────────────────────────────────────────────────────────────

/** Length of a target period in months, or null for weekly / single-month cadences. */
export function periodMonths(t: Pick<EngineTarget, "cadence" | "cadenceEvery" | "targetDate">): number | null {
  const n = Math.max(1, t.cadenceEvery || 1);
  switch (t.cadence) {
    case "weekly":
      return null;
    case "monthly":
      return n > 1 ? n : null;
    case "every_n_months":
      return n > 1 ? n : null;
    case "yearly":
      return 12 * n;
    case "none":
      return null;
  }
}

export interface TargetPeriod {
  start: Month;
  end: Month;
  /** Months left in the period including M (≥ 1). */
  monthsLeft: number;
}

/**
 * The target period containing `month`.
 *  - Repeating multi-month cadences: periods of P months ending at the target-date month + k·P.
 *  - Non-repeating (`none` with a target date): from the creation month through the target month;
 *    after the target month, everything left is due now (monthsLeft = 1).
 */
export function targetPeriod(t: EngineTarget, month: Month): TargetPeriod | null {
  const P = periodMonths(t);
  if (P !== null) {
    const due = t.targetDate ? monthOf(t.targetDate) : addMonths(t.effectiveFrom, P - 1);
    const diff = monthsBetween(due, month) - 1; // months from due to month (0 = same)
    const k = Math.ceil(diff / P);
    const end = addMonths(due, k * P);
    const start = addMonths(end, -(P - 1));
    return { start, end, monthsLeft: monthsBetween(month, end) };
  }
  if (t.cadence === "none" && t.targetDate) {
    const end = monthOf(t.targetDate);
    const start = t.createdMonth < t.effectiveFrom ? t.createdMonth : t.effectiveFrom;
    return { start, end, monthsLeft: Math.max(1, monthsBetween(month, end)) };
  }
  return null;
}

/** Weekly due dates of the target in `month` (honours every-N-weeks via the targetDate anchor). */
export function weeklyDueDates(t: EngineTarget, month: Month): ISODate[] {
  const day = t.day ?? 0;
  const n = Math.max(1, t.cadenceEvery || 1);
  const out: ISODate[] = [];
  for (let i = 1; i <= daysInMonth(month); i++) {
    const d = `${month.slice(0, 8)}${String(i).padStart(2, "0")}`;
    if (weekday(d) !== day) continue;
    if (n > 1 && t.targetDate) {
      const weeks = Math.round(daysBetween(t.targetDate, d) / 7);
      if (((weeks % n) + n) % n !== 0) continue;
    }
    out.push(d);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// needed(M)
// ─────────────────────────────────────────────────────────────────────────────

export interface TargetInputs {
  month: Month;
  kind: CategoryKind;
  target: EngineTarget | null;
  carryIn: Milli;
  assigned: Milli;
  activity: Milli;
  /** Assigned(c, m) for earlier months (for set-aside periods). */
  assignedIn: (month: Month) => Milli;
  /** Net inflows to Ready to Assign in `month` (default percent-of-income basis). */
  income: Milli;
  incomeOverrides?: IncomeBasisOverride[];
  /** Outflow magnitude of upcoming scheduled transactions in the month (≥ 0). */
  upcoming: Milli;
  /** For payment categories: what is owed on the card at month end (≥ 0). */
  debt?: Milli;
  balanceTargetIncludesActivity?: boolean;
}

export interface TargetMonth {
  /** Final needed(M) (0 when snoozed, before subtracting assigned). */
  needed: Milli;
  /** needed ignoring snooze (used by Reduce Overfunding). */
  neededUnsnoozed: Milli;
  /** The target's own need (no schedule / debt alert). */
  targetNeeded: Milli;
  /** Need from upcoming scheduled transactions (before assigned). */
  scheduleNeeded: Milli;
  /** Need from card debt for a payment category without a target. */
  debtNeeded: Milli;
  underfunded: Milli;
  overallLeft: Milli;
  pctComplete: number;
  hasTarget: boolean;
  snoozed: boolean;
}

interface Need {
  needed: Milli;
  overallTarget: Milli;
  overallFunded: Milli;
}

function max0(a: Milli): Milli {
  return a > 0n ? a : 0n;
}

function sumAssigned(inp: TargetInputs, start: Month, endExclusive: Month): Milli {
  let s = 0n;
  for (let m = start; m < endExclusive; m = addMonths(m, 1)) s += inp.assignedIn(m);
  return s;
}

function incomeBasis(inp: TargetInputs, basis: "rta_inflows" | "gross_pay"): Milli {
  const o = inp.incomeOverrides?.find((x) => x.month === inp.month && x.basis === basis);
  if (o) return o.amount;
  return basis === "rta_inflows" ? inp.income : 0n;
}

/** needed(M) for a target, before snooze. */
export function targetNeed(t: EngineTarget, inp: TargetInputs): Need {
  const X = t.amount;
  const { month, carryIn: carry, assigned: A } = inp;
  const type: TargetType = t.type;
  switch (type) {
    case "need_set_aside": {
      if (t.cadence === "weekly") {
        const n = BigInt(weeklyDueDates(t, month).length);
        return { needed: X * n, overallTarget: X * n, overallFunded: A };
      }
      const p = targetPeriod(t, month);
      if (!p) return { needed: X, overallTarget: X, overallFunded: A };
      const prior = sumAssigned(inp, p.start < month ? p.start : month, month);
      const left = month > p.end ? 1 : p.monthsLeft;
      return { needed: ceilCentsDiv(max0(X - prior), BigInt(left)), overallTarget: X, overallFunded: prior + A };
    }
    case "need_refill": {
      if (t.cadence === "weekly") {
        const xw = X * BigInt(weeklyDueDates(t, month).length);
        return { needed: max0(xw - carry), overallTarget: xw, overallFunded: carry + A };
      }
      const p = targetPeriod(t, month);
      if (!p) return { needed: max0(X - carry), overallTarget: X, overallFunded: carry + A };
      const left = month > p.end ? 1 : p.monthsLeft;
      return { needed: ceilCentsDiv(max0(X - carry), BigInt(left)), overallTarget: X, overallFunded: carry + A };
    }
    case "balance": {
      const base = inp.balanceTargetIncludesActivity ? carry + inp.activity : carry;
      return { needed: max0(X - base), overallTarget: X, overallFunded: base + A };
    }
    case "balance_by_date": {
      const left = t.targetDate ? Math.max(1, monthsBetween(month, monthOf(t.targetDate))) : 1;
      return { needed: ceilCentsDiv(max0(X - carry), BigInt(left)), overallTarget: X, overallFunded: carry + A };
    }
    case "monthly_builder":
    case "debt":
      return { needed: X, overallTarget: X, overallFunded: A };
    case "percent_of_income": {
      const basis = incomeBasis(inp, t.incomeBasis ?? "rta_inflows");
      const need = t.percent === null ? 0n : max0(percentOf(basis, t.percent));
      return { needed: need, overallTarget: need, overallFunded: A };
    }
  }
}

/** Full per-month target figures for one category (§6.5). */
export function computeTargetMonth(inp: TargetInputs): TargetMonth {
  const t = inp.target;
  const before = inp.carryIn + inp.activity; // Available before this month's assignment
  const scheduleNeeded = inp.upcoming > 0n ? max0(inp.upcoming - before) : 0n;
  const debtNeeded = inp.kind === "cc_payment" && !t && inp.debt !== undefined ? max0(inp.debt - before) : 0n;

  let need: Need = { needed: 0n, overallTarget: 0n, overallFunded: 0n };
  let snoozed = false;
  if (t) {
    need = targetNeed(t, inp);
    snoozed = t.snoozedMonth === inp.month;
  }
  const targetNeeded = snoozed ? 0n : need.needed;
  const pick = (tn: Milli) => [tn, scheduleNeeded, debtNeeded].reduce((a, b) => (b > a ? b : a));
  const needed = pick(targetNeeded);
  const neededUnsnoozed = pick(need.needed);
  const underfunded = max0(needed - inp.assigned);

  let overallLeft: Milli;
  let pctComplete: number;
  if (t) {
    overallLeft = snoozed ? 0n : max0(need.overallTarget - need.overallFunded);
    if (need.overallTarget <= 0n) pctComplete = 100;
    else {
      const f = need.overallFunded <= 0n ? 0n : need.overallFunded;
      const p = (f * 100n) / need.overallTarget;
      pctComplete = Number(p > 100n ? 100n : p);
    }
    if (underfunded > overallLeft) overallLeft = underfunded;
  } else {
    overallLeft = underfunded;
    const base = needed;
    if (base <= 0n) pctComplete = 0;
    else {
      const f = max0(inp.assigned);
      pctComplete = Number(f >= base ? 100n : (f * 100n) / base);
    }
  }
  return { needed, neededUnsnoozed, targetNeeded, scheduleNeeded, debtNeeded, underfunded, overallLeft, pctComplete, hasTarget: t !== null, snoozed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Due date (for auto-assign ordering)
// ─────────────────────────────────────────────────────────────────────────────

export type DueRank =
  | { kind: "dated"; date: ISODate } // weekly / monthly with specific day, due in M
  | { kind: "end_of_month" }
  | { kind: "future"; month: Month } // custom targets due after M
  | { kind: "none" }; // e.g. "have a balance" without a date (YNAB skips these in Underfunded)

export function targetDue(t: EngineTarget, month: Month): DueRank {
  if (t.cadence === "weekly") {
    const d = weeklyDueDates(t, month)[0];
    return d ? { kind: "dated", date: d } : { kind: "end_of_month" };
  }
  if (t.type === "balance" && !t.targetDate) return { kind: "none" };
  const p = targetPeriod(t, month);
  if (t.type === "balance_by_date" && t.targetDate) {
    const tm = monthOf(t.targetDate);
    return tm > month ? { kind: "future", month: tm } : { kind: "dated", date: t.targetDate };
  }
  if (p && p.end > month) return { kind: "future", month: p.end };
  if (t.day !== null && t.day !== undefined) {
    const d = Math.min(Math.max(1, t.day), daysInMonth(month));
    return { kind: "dated", date: `${month.slice(0, 8)}${String(d).padStart(2, "0")}` };
  }
  return { kind: "end_of_month" };
}

// ─────────────────────────────────────────────────────────────────────────────
// YNAB goal mapping (§6.5 cadence table, §10)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * YNAB `goal_cadence` codes (verified against https://api.ynab.com/papi/open_api_spec.yaml, Oct 2026):
 *  0 = None, 1 = Monthly, 2 = Weekly, 13 = Yearly — repeat every `goal_cadence_frequency` units;
 *  3 = Every 2 Months, 4 = Every 3 Months, …, 12 = Every 11 Months, 14 = Every 2 Years —
 *  `goal_cadence_frequency` is ignored.
 */
export const YNAB_GOAL_CADENCE: Readonly<Record<number, { label: string; cadence: Cadence; every: number | "frequency" }>> = {
  0: { label: "None", cadence: "none", every: 1 },
  1: { label: "Monthly", cadence: "monthly", every: "frequency" },
  2: { label: "Weekly", cadence: "weekly", every: "frequency" },
  3: { label: "Every 2 Months", cadence: "every_n_months", every: 2 },
  4: { label: "Every 3 Months", cadence: "every_n_months", every: 3 },
  5: { label: "Every 4 Months", cadence: "every_n_months", every: 4 },
  6: { label: "Every 5 Months", cadence: "every_n_months", every: 5 },
  7: { label: "Every 6 Months", cadence: "every_n_months", every: 6 },
  8: { label: "Every 7 Months", cadence: "every_n_months", every: 7 },
  9: { label: "Every 8 Months", cadence: "every_n_months", every: 8 },
  10: { label: "Every 9 Months", cadence: "every_n_months", every: 9 },
  11: { label: "Every 10 Months", cadence: "every_n_months", every: 10 },
  12: { label: "Every 11 Months", cadence: "every_n_months", every: 11 },
  13: { label: "Yearly", cadence: "yearly", every: "frequency" },
  14: { label: "Every 2 Years", cadence: "yearly", every: 2 },
};

/** Map YNAB goal_cadence + goal_cadence_frequency to Homebase cadence + cadenceEvery. */
export function mapYnabCadence(goalCadence: number | null | undefined, frequency: number | null | undefined): { cadence: Cadence; cadenceEvery: number } {
  const entry = YNAB_GOAL_CADENCE[goalCadence ?? 0] ?? YNAB_GOAL_CADENCE[0]!;
  const freq = frequency && frequency > 0 ? frequency : 1;
  const every = entry.every === "frequency" ? freq : entry.every;
  if (entry.cadence === "monthly" && every > 1) return { cadence: "every_n_months", cadenceEvery: every };
  return { cadence: entry.cadence, cadenceEvery: every };
}

/** The goal fields of a YNAB category (API v1 `Category`). */
export interface YnabGoalFields {
  id: string;
  goal_type?: string | null;
  goal_needs_whole_amount?: boolean | null;
  goal_day?: number | null;
  goal_cadence?: number | null;
  goal_cadence_frequency?: number | null;
  goal_creation_month?: string | null;
  goal_target?: number | null;
  goal_target_date?: string | null;
  goal_target_month?: string | null;
  goal_snoozed_at?: string | null;
}

/**
 * Map a YNAB category's goal to an EngineTarget (§10):
 *  NEED + goal_needs_whole_amount=true → need_set_aside; NEED + false/null → need_refill;
 *  TB → balance; TBD → balance_by_date; MF → monthly_builder; DEBT → debt.
 * Imported targets get effectiveFrom = goal_creation_month (YNAB only exposes the current target).
 * `snoozedMonth` is the month of goal_snoozed_at (YNAB snoozes for the month it was snoozed in).
 */
export function mapYnabGoal(c: YnabGoalFields, fallbackMonth?: Month): EngineTarget | null {
  if (!c.goal_type) return null;
  let type: TargetType;
  switch (c.goal_type) {
    case "NEED":
      type = c.goal_needs_whole_amount === true ? "need_set_aside" : "need_refill";
      break;
    case "TB":
      type = "balance";
      break;
    case "TBD":
      type = "balance_by_date";
      break;
    case "MF":
      type = "monthly_builder";
      break;
    case "DEBT":
      type = "debt";
      break;
    default:
      return null;
  }
  const { cadence: rawCadence, cadenceEvery } = mapYnabCadence(c.goal_cadence, c.goal_cadence_frequency);
  const targetDate = c.goal_target_date ?? c.goal_target_month ?? null;
  // Legacy goals (cadence null/0) without a date behave monthly; MF and DEBT are monthly by definition.
  let cadence: Cadence = rawCadence;
  if ((type === "monthly_builder" || type === "debt") && cadence === "none") cadence = "monthly";
  if ((type === "need_set_aside" || type === "need_refill") && cadence === "none" && !targetDate) cadence = "monthly";
  const created = c.goal_creation_month ? monthOf(c.goal_creation_month) : (fallbackMonth ?? "1970-01-01");
  return {
    categoryId: c.id,
    effectiveFrom: created,
    type,
    amount: BigInt(c.goal_target ?? 0),
    cadence,
    cadenceEvery,
    day: c.goal_day ?? null,
    targetDate,
    percent: null,
    snoozedMonth: c.goal_snoozed_at ? monthOf(c.goal_snoozed_at.length > 10 ? toLocalDate(c.goal_snoozed_at) : c.goal_snoozed_at) : null,
    createdMonth: created,
  };
}
