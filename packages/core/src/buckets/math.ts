/**
 * Pure bucket math for the simple Budget screen (ADR "Web: simple bucket budget (glow)").
 *
 * A bucket is a normal category with a monthly goal. `budget` is the goal's monthly amount, `spent` is
 * the month's net outflow categorized to it (refunds reduce it), `remaining = budget − spent`.
 * The bar shows what is LEFT: full at the start of the month, empty when the budget is used up, then a
 * red bar fills back up as the bucket goes over (capped at 100% over).
 *
 * Overflow (rollover) buckets add last month's leftover to the budget (see the bottom of this file).
 *
 * All money is bigint milliunits; fractions are plain numbers in [0, 1] (display only).
 */
import { addMonths, daysInMonth, divRound, monthOf, weekdayCount, type ISODate, type Milli, type Month, type TargetType } from "@homebase/shared";

/** monthly = spend-down bucket; balance = a savings goal (balance / balance by date). */
export type GoalKind = "monthly" | "balance";

export interface GoalLike {
  type: TargetType;
  amount: Milli;
  cadence: "none" | "weekly" | "monthly" | "yearly" | "every_n_months";
  cadenceEvery: number;
  /** Weekly: weekday 0=Sun…6=Sat. */
  day: number | null;
}

export interface MonthlyGoal {
  amount: Milli;
  kind: GoalKind;
}

/**
 * The goal's effective amount for `month`:
 * - need_set_aside / need_refill: the target amount, per month (weekly × occurrences of the weekday in
 *   the month; yearly ÷ 12·n; every n months ÷ n), rounded to the cent;
 * - monthly_builder / debt: the monthly amount;
 * - balance / balance_by_date: the target balance (kind "balance");
 * - percent_of_income: `percentNeeded` (the engine's needed amount for the month) when it is known.
 * Returns null when there is no usable amount (zero, or percent of income without the engine number).
 */
export function monthlyGoalAmount(goal: GoalLike, month: Month, opts: { percentNeeded?: Milli | null } = {}): MonthlyGoal | null {
  const every = BigInt(Math.max(1, goal.cadenceEvery || 1));
  let amount: Milli;
  let kind: GoalKind = "monthly";
  switch (goal.type) {
    case "balance":
    case "balance_by_date":
      amount = goal.amount;
      kind = "balance";
      break;
    case "percent_of_income":
      amount = opts.percentNeeded ?? 0n;
      break;
    case "monthly_builder":
    case "debt":
      amount = goal.amount;
      break;
    case "need_set_aside":
    case "need_refill":
      if (goal.cadence === "weekly") amount = divRound(goal.amount * BigInt(weekdayCount(month, goal.day ?? 0)), every);
      else if (goal.cadence === "yearly") amount = divRound(goal.amount, 12n * every);
      else if (goal.cadence === "every_n_months") amount = divRound(goal.amount, every);
      else amount = goal.amount;
      amount = divRound(amount, 10n) * 10n;
      break;
  }
  return amount > 0n ? { amount, kind } : null;
}

export type BarState = "none" | "under" | "warn" | "over";

export interface BucketBar {
  state: BarState;
  /** Accent fill: the remaining share of the budget, 0..1 (0 when over). */
  fill: number;
  /** Red fill: how far over, as a share of the budget, 0..1 (capped). */
  over: number;
  /** spent ÷ budget (unclamped; 0 when there is no budget). */
  spentRatio: number;
  remaining: Milli;
}

/** spent ≥ this share of the budget turns the bar amber. */
export const WARN_RATIO = 0.85;

/** a ÷ b as a number with 4 decimals of precision (both bigint). */
export function ratio(a: Milli, b: Milli): number {
  if (b === 0n) return 0;
  return Number((a * 10_000n) / b) / 10_000;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * The bar for one bucket. No budget (null or ≤ 0) → state "none" (show spent only).
 * spent ≤ budget → accent fill = remaining ÷ budget; spent > budget → red fill = min((spent − budget) ÷ budget, 1).
 */
export function bucketBar(budget: Milli | null, spent: Milli): BucketBar {
  if (budget === null || budget <= 0n) return { state: "none", fill: 0, over: 0, spentRatio: 0, remaining: -spent };
  const remaining = budget - spent;
  const spentRatio = ratio(spent, budget);
  if (spent > budget) return { state: "over", fill: 0, over: clamp01(ratio(spent - budget, budget)), spentRatio, remaining };
  return { state: spentRatio >= WARN_RATIO ? "warn" : "under", fill: clamp01(ratio(remaining, budget)), over: 0, spentRatio, remaining };
}

export interface MonthPace {
  /** Share of the month elapsed (1 for past months, 0 for future ones). Today counts as elapsed. */
  elapsed: number;
  /** Days left including today (0 for past months). */
  daysLeft: number;
  daysInMonth: number;
  /** ahead = spending faster than the month is passing (by more than 5 points). */
  status: "ahead" | "on_pace" | "behind" | "none";
  /** spent ÷ budget. */
  spentRatio: number;
}

export const PACE_TOLERANCE = 0.05;

export function monthPace(month: Month, today: ISODate, budget: Milli, spent: Milli): MonthPace {
  const dim = daysInMonth(month);
  const cur = monthOf(today);
  const day = Number(today.slice(8, 10));
  const elapsed = month < cur ? 1 : month > cur ? 0 : day / dim;
  const daysLeft = month < cur ? 0 : month > cur ? dim : dim - day + 1;
  const spentRatio = ratio(spent, budget);
  let status: MonthPace["status"] = "none";
  if (budget > 0n && month <= cur) status = spentRatio > elapsed + PACE_TOLERANCE ? "ahead" : spentRatio < elapsed - PACE_TOLERANCE ? "behind" : "on_pace";
  return { elapsed, daysLeft, daysInMonth: dim, status, spentRatio };
}

export interface TotalsInput {
  budget: Milli | null;
  spent: Milli;
  kind: GoalKind | null;
}

export interface BucketTotals {
  /** Σ monthly budgets (savings goals excluded: their amount is a balance, not this month's spending). */
  budget: Milli;
  /** Σ spent across every bucket (with or without a goal). */
  spent: Milli;
  /** Σ spent in buckets with a monthly goal. */
  budgetedSpent: Milli;
  /** budget − budgetedSpent. */
  left: Milli;
  /** Spending in buckets without a monthly goal. */
  unbudgetedSpent: Milli;
}

/** Month totals for the summary. */
export function bucketTotals(rows: readonly TotalsInput[]): BucketTotals {
  let budget = 0n;
  let spent = 0n;
  let unbudgeted = 0n;
  for (const r of rows) {
    spent += r.spent;
    if (r.budget !== null && r.kind === "monthly") budget += r.budget;
    else unbudgeted += r.spent;
  }
  return { budget, spent, budgetedSpent: spent - unbudgeted, left: budget - (spent - unbudgeted), unbudgetedSpent: unbudgeted };
}

// ── overflow (rollover) ─────────────────────────────────────────────────────
// ADR "Buckets: overflow (rollover)". A rollover bucket carries what is left at the end of a month into
// the next one: carryIn(from) = opening; carryIn(M) = max(0, budget(M−1) − spent(M−1)) after that, where
// budget(M) = monthlyGoal(M) + carryIn(M). Overspending never carries (the floor is 0). Before `from`, or
// with rollover off, there is no carry.

export interface RolloverSettings {
  enabled: boolean;
  /** First month that counts (the month rollover was turned on). */
  from: Month | null;
  /** Carried into the `from` month (money already saved); negative counts as 0. */
  opening: Milli;
}

export interface RolloverMonth {
  month: Month;
  /** The plain monthly goal that month (0 without one). */
  goal: Milli;
  carryIn: Milli;
  /** goal + carryIn. */
  budget: Milli;
  spent: Milli;
  /** max(0, budget − spent): next month's carryIn. */
  carryOut: Milli;
}

const floor0 = (m: Milli): Milli => (m > 0n ? m : 0n);

/**
 * Month-by-month carry from `from` through `through` (inclusive; empty when through < from).
 * `goalFor` / `spentFor` give each month's plain monthly goal and net spending.
 */
export function rolloverSchedule(input: { from: Month; opening: Milli; through: Month; goalFor: (m: Month) => Milli; spentFor: (m: Month) => Milli }): RolloverMonth[] {
  const out: RolloverMonth[] = [];
  let carry = floor0(input.opening);
  for (let m = input.from; m <= input.through; m = addMonths(m, 1)) {
    const goal = floor0(input.goalFor(m));
    const spent = input.spentFor(m);
    const budget = goal + carry;
    const carryOut = floor0(budget - spent);
    out.push({ month: m, goal, carryIn: carry, budget, spent, carryOut });
    carry = carryOut;
  }
  return out;
}

/** What rolls into `month` for a bucket (0 when rollover is off or `month` is before it started). */
export function rolloverCarryIn(settings: RolloverSettings, month: Month, goalFor: (m: Month) => Milli, spentFor: (m: Month) => Milli): Milli {
  if (!settings.enabled || !settings.from || month < settings.from) return 0n;
  if (month === settings.from) return floor0(settings.opening);
  const sched = rolloverSchedule({ from: settings.from, opening: settings.opening, through: addMonths(month, -1), goalFor, spentFor });
  return sched[sched.length - 1]?.carryOut ?? 0n;
}

export interface GoalHistoryRow extends GoalLike {
  /** First month the row applies (until the next row). */
  effectiveFrom: Month;
  /** A removed row ends the goal from that month on. */
  removed: boolean;
}

/** The goal row in effect for `month`: the latest row with effectiveFrom ≤ month, null when none or removed. */
export function goalInEffect<T extends { effectiveFrom: Month; removed: boolean }>(history: readonly T[], month: Month): T | null {
  let best: T | null = null;
  for (const r of history) if (r.effectiveFrom <= month && (!best || r.effectiveFrom > best.effectiveFrom)) best = r;
  return best && !best.removed ? best : null;
}

/**
 * The plain monthly goal a rollover bucket adds in `month`, from its target history. Savings (balance)
 * goals add nothing (their amount is a balance, not a month's money); percent of income uses
 * `percentNeeded` when given (only known for the month on screen), else 0.
 */
export function monthlyGoalFromHistory(history: readonly GoalHistoryRow[], month: Month, opts: { percentNeeded?: Milli | null } = {}): Milli {
  const row = goalInEffect(history, month);
  if (!row) return 0n;
  const g = monthlyGoalAmount(row, month, opts);
  return g && g.kind === "monthly" ? g.amount : 0n;
}

// ── savings buckets ─────────────────────────────────────────────────────────
// ADR "Buckets: savings buckets". A savings bucket has no monthly goal: money is added as it comes in.
// From `from` on: carryIn(from) = opening; contributed(M) = Σ month_assignments in M (negative = taken
// out); balance(M) = carryIn(M) + contributed(M) − spent(M); carryIn(M+1) = max(0, balance(M)).
// Months before `from` don't count.

export type BucketKind = "spending" | "savings";

export interface SavingsSettings {
  /** First month that counts (the month it became a savings bucket). */
  from: Month;
  /** Starting balance carried into `from`; negative counts as 0. */
  opening: Milli;
}

export interface SavingsMonth {
  month: Month;
  carryIn: Milli;
  /** Added this month (negative when more was taken out than added). */
  contributed: Milli;
  /** Net spending this month (refunds reduce it). */
  spent: Milli;
  /** End of month: carryIn + contributed − spent (may be negative after overspending). */
  balance: Milli;
  /** max(0, balance): next month's carryIn. */
  carryOut: Milli;
}

/** Month-by-month savings walk from `settings.from` through `through` (inclusive; empty when through < from). */
export function savingsSchedule(settings: SavingsSettings, through: Month, contributedFor: (m: Month) => Milli, spentFor: (m: Month) => Milli): SavingsMonth[] {
  const out: SavingsMonth[] = [];
  let carry = floor0(settings.opening);
  for (let m = settings.from; m <= through; m = addMonths(m, 1)) {
    const contributed = contributedFor(m);
    const spent = spentFor(m);
    const balance = carry + contributed - spent;
    const carryOut = floor0(balance);
    out.push({ month: m, carryIn: carry, contributed, spent, balance, carryOut });
    carry = carryOut;
  }
  return out;
}

/** One month of a savings bucket; all zero (and `started: false`) before it starts. */
export function savingsMonth(settings: SavingsSettings, month: Month, contributedFor: (m: Month) => Milli, spentFor: (m: Month) => Milli): SavingsMonth & { started: boolean } {
  if (month < settings.from) return { month, carryIn: 0n, contributed: 0n, spent: 0n, balance: 0n, carryOut: 0n, started: false };
  const s = savingsSchedule(settings, month, contributedFor, spentFor);
  return { ...s[s.length - 1]!, started: true };
}

/** balance ÷ target in [0, 1] (null without a target). */
export function savingsProgress(balance: Milli, target: Milli | null): number | null {
  if (target === null || target <= 0n) return null;
  return clamp01(ratio(balance, target));
}

/**
 * Can `amount` be added to (positive) or taken out of (negative) a savings bucket whose balance is
 * `balance`? Taking out more than the balance is refused (null = ok, else the reason).
 */
export function savingsChangeError(balance: Milli, amount: Milli): string | null {
  if (amount === 0n) return "amount can't be zero";
  if (amount < 0n && -amount > (balance > 0n ? balance : 0n)) return "can't take out more than the balance";
  return null;
}
