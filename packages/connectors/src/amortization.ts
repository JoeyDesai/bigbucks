/**
 * Mortgage amortization engine (§7.7). All money is bigint milliunits; rates are exact decimal strings
 * converted to rationals, so no floating point touches money. Each period's interest is rounded to cents
 * (half away from zero), the payment is rounded to cents, and the final payment absorbs the remainder.
 *
 * Monthly rate r = annual / 12. Payment = P·r / (1 − (1+r)^−n). Balance after k = P(1+r)^k − pmt((1+r)^k − 1)/r.
 */
import { daysInMonth, divRound, type ISODate, type Milli } from "@homebase/shared";
import { ConnectorError } from "./types";

/** Exact rational monthly rate: r = num / den. */
export interface Rate {
  /** Annual percentage as given, e.g. "6.5". */
  annualPct: string;
  num: bigint;
  den: bigint;
}

/** "6.5" (percent) → exact monthly rational. Accepts "6.5%". */
export function parseAnnualRate(annualPct: string | number): Rate {
  const s = String(annualPct).trim().replace(/%$/, "");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new ConnectorError("invalid_input", `Invalid annual rate: ${annualPct}`);
  const frac = m[2] ?? "";
  const num = BigInt(m[1]! + frac);
  // percent → fraction (/100), annual → monthly (/12)
  const den = 10n ** BigInt(frac.length) * 100n * 12n;
  return { annualPct: s, num, den };
}

/** DB stores `loans.annual_rate` as a decimal fraction string ("0.065"); convert exactly to percent ("6.5"). */
export function fractionToPercent(fraction: string): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(fraction.trim());
  if (!m) throw new ConnectorError("invalid_input", `Invalid rate fraction: ${fraction}`);
  const frac = (m[2] ?? "").padEnd(2, "0");
  const int = `${m[1]}${frac.slice(0, 2)}`.replace(/^0+(?=\d)/, "");
  const rest = frac.slice(2).replace(/0+$/, "");
  return rest ? `${int}.${rest}` : int;
}

const toCents = (milliNumer: bigint, denom: bigint): Milli => divRound(milliNumer, denom * 10n) * 10n;

/** Level monthly P&I payment, rounded to cents. */
export function monthlyPayment(principal: Milli, annualPct: string | number | Rate, termMonths: number): Milli {
  if (termMonths <= 0) throw new ConnectorError("invalid_input", "termMonths must be > 0");
  if (principal <= 0n) return 0n;
  const r = typeof annualPct === "object" ? annualPct : parseAnnualRate(annualPct);
  const n = BigInt(termMonths);
  if (r.num === 0n) return toCents(principal, n);
  const g = (r.den + r.num) ** n; // (1+r)^n · den^n
  const dn = r.den ** n;
  return toCents(principal * r.num * g, r.den * (g - dn));
}

/** Closed-form balance after k level payments (cents). Uses the rounded payment unless one is given. */
export function balanceAfterPayments(principal: Milli, annualPct: string | number | Rate, termMonths: number, k: number, payment?: Milli): Milli {
  const r = typeof annualPct === "object" ? annualPct : parseAnnualRate(annualPct);
  const pmt = payment ?? monthlyPayment(principal, r, termMonths);
  if (k <= 0) return principal;
  const kk = BigInt(k);
  if (r.num === 0n) {
    const b = principal - pmt * kk;
    return b > 0n ? b : 0n;
  }
  const g = (r.den + r.num) ** kk;
  const dk = r.den ** kk;
  // [P·g − pmt·(g − dk)·den/num] / dk  →  [P·g·num − pmt·(g − dk)·den] / (dk·num)
  const numer = principal * g * r.num - pmt * (g - dk) * r.den;
  const b = toCents(numer, dk * r.num);
  return b > 0n ? b : 0n;
}

/** One period's interest on `balance`, rounded to cents. */
export function periodInterest(balance: Milli, r: Rate): Milli {
  return toCents(balance * r.num, r.den);
}

// ---------------------------------------------------------------------------------------------------------------------
// Schedule with loan_events

export type LoanEvent =
  | { type: "extra_principal"; date: ISODate; amount: Milli; note?: string }
  /** Re-amortize remaining balance over the remaining term (maturity unchanged). Servicer's new payment wins if given. */
  | { type: "recast"; date: ISODate; newPayment?: Milli; note?: string }
  | { type: "rate_change"; date: ISODate; annualRate: string; newPayment?: Milli; note?: string }
  /** Statement says the principal balance is X; snap to it. */
  | { type: "balance_correction"; date: ISODate; balance: Milli; note?: string };

export interface LoanTerms {
  principal: Milli;
  annualRate: string;
  termMonths: number;
  /** Due date of payment #1. Subsequent payments fall on the same day-of-month (clamped). */
  firstPaymentDate: ISODate;
}

export interface ScheduleRow {
  period: number;
  date: ISODate;
  /** Scheduled P&I paid this period (final period may be smaller). Excludes escrow. */
  payment: Milli;
  interest: Milli;
  principal: Milli;
  /** Extra principal applied this period (lump-sum events applied before it + recurring extra). */
  extraPrincipal: Milli;
  /** Principal balance after this period. */
  balance: Milli;
  annualRate: string;
  events: LoanEvent[];
}

export interface Schedule {
  rows: ScheduleRow[];
  initialPayment: Milli;
  payoffDate: ISODate | null;
  totalInterest: Milli;
  totalPaid: Milli;
}

/** Same day-of-month k months later, clamped to month end. */
export function addMonthsToDate(date: ISODate, k: number): ISODate {
  const y = Number(date.slice(0, 4));
  const m0 = Number(date.slice(5, 7)) - 1 + k;
  const d = Number(date.slice(8, 10));
  const yy = y + Math.floor(m0 / 12);
  const mm = ((m0 % 12) + 12) % 12;
  const month = `${yy}-${String(mm + 1).padStart(2, "0")}-01`;
  const day = Math.min(d, daysInMonth(month));
  return `${month.slice(0, 8)}${String(day).padStart(2, "0")}`;
}

export interface ScheduleOptions {
  /** Recurring extra principal paid with every payment. */
  extraMonthly?: Milli;
  /** Safety cap on generated periods (default term + 600). */
  maxPeriods?: number;
}

/**
 * Build the amortization schedule. An event dated d is applied after the last payment due on or before d,
 * i.e. before the interest of the first period whose due date is after d.
 */
export function buildSchedule(loan: LoanTerms, events: LoanEvent[] = [], o: ScheduleOptions = {}): Schedule {
  let rate = parseAnnualRate(loan.annualRate);
  let payment = monthlyPayment(loan.principal, rate, loan.termMonths);
  const initialPayment = payment;
  let balance = loan.principal;
  const pending = [...events].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const extraMonthly = o.extraMonthly ?? 0n;
  if (extraMonthly < 0n) throw new ConnectorError("invalid_input", "extraMonthly must be ≥ 0");
  const maxPeriods = o.maxPeriods ?? loan.termMonths + 600;
  const rows: ScheduleRow[] = [];
  let totalInterest = 0n;
  let totalPaid = 0n;

  for (let i = 1; i <= maxPeriods && balance > 0n; i++) {
    const due = addMonthsToDate(loan.firstPaymentDate, i - 1);
    const remaining = Math.max(1, loan.termMonths - (i - 1));
    let lump = 0n;
    const applied: LoanEvent[] = [];
    while (pending.length && pending[0]!.date < due) {
      const ev = pending.shift()!;
      applied.push(ev);
      switch (ev.type) {
        case "extra_principal": {
          const amt = ev.amount > balance ? balance : ev.amount;
          balance -= amt;
          lump += amt;
          break;
        }
        case "recast":
          payment = ev.newPayment ?? monthlyPayment(balance, rate, remaining);
          break;
        case "rate_change":
          rate = parseAnnualRate(ev.annualRate);
          payment = ev.newPayment ?? monthlyPayment(balance, rate, remaining);
          break;
        case "balance_correction":
          balance = ev.balance;
          break;
      }
    }
    if (balance <= 0n) {
      // Paid off by a lump sum before this period.
      if (rows.length && lump > 0n) {
        const last = rows[rows.length - 1]!;
        last.extraPrincipal += lump;
        last.balance = 0n;
        last.events.push(...applied);
        totalPaid += lump;
      }
      break;
    }
    const interest = periodInterest(balance, rate);
    let pay = payment;
    let principal = pay - interest;
    if (principal < 0n) principal = 0n; // negative amortization isn't modeled; interest-only floor
    // The final scheduled payment (maturity) absorbs the rounding remainder from the cent-rounded payment.
    if (i >= loan.termMonths || balance + interest <= pay || principal >= balance) {
      principal = balance;
      pay = balance + interest;
    }
    balance -= principal;
    let extra = 0n;
    if (extraMonthly > 0n && balance > 0n) {
      extra = extraMonthly > balance ? balance : extraMonthly;
      balance -= extra;
    }
    totalInterest += interest;
    totalPaid += pay + extra + lump;
    rows.push({ period: i, date: due, payment: pay, interest, principal, extraPrincipal: extra + lump, balance, annualRate: rate.annualPct, events: applied });
  }
  if (balance > 0n) throw new ConnectorError("invalid_input", "Loan does not amortize within maxPeriods (payment ≤ interest?)");
  return { rows, initialPayment, payoffDate: rows.length ? rows[rows.length - 1]!.date : null, totalInterest, totalPaid };
}

/** Principal balance per the schedule as of a date (after all payments due on or before it). */
export function scheduledBalanceAsOf(loan: LoanTerms, schedule: Schedule, asOf: ISODate): Milli {
  let b = loan.principal;
  for (const r of schedule.rows) {
    if (r.date > asOf) break;
    b = r.balance;
  }
  return b;
}

/** Σ interest of payments due on or before asOf. */
export function interestPaidToDate(schedule: Schedule, asOf: ISODate): Milli {
  let t = 0n;
  for (const r of schedule.rows) if (r.date <= asOf) t += r.interest;
  return t;
}

export function payoffDate(schedule: Schedule): ISODate | null {
  return schedule.payoffDate;
}

/** §7.7.3: flag drift > $50 between the synced (servicer) balance and the schedule. Compares amounts owed (absolute). */
export function balanceDrift(syncedBalance: Milli, scheduledBalance: Milli, thresholdMilli: Milli = 50_000n): { drift: Milli; flagged: boolean } {
  const abs = (x: Milli) => (x < 0n ? -x : x);
  const drift = abs(syncedBalance) - abs(scheduledBalance);
  return { drift, flagged: abs(drift) > thresholdMilli };
}

export interface WhatIfResult {
  baseline: { payoffDate: ISODate | null; months: number; totalInterest: Milli; payment: Milli };
  scenario: { payoffDate: ISODate | null; months: number; totalInterest: Milli; payment: Milli };
  interestSaved: Milli;
  monthsSaved: number;
  scenarioSchedule: Schedule;
}

/**
 * What-if: extra monthly principal and/or extra one-off events (e.g. a lump sum followed by a recast),
 * layered on top of the loan's existing events.
 */
export function whatIf(loan: LoanTerms, existingEvents: LoanEvent[] = [], scenario: { extraMonthly?: Milli; extraEvents?: LoanEvent[] } = {}): WhatIfResult {
  const base = buildSchedule(loan, existingEvents);
  const sc = buildSchedule(loan, [...existingEvents, ...(scenario.extraEvents ?? [])], scenario.extraMonthly !== undefined ? { extraMonthly: scenario.extraMonthly } : {});
  const lastPayment = (s: Schedule) => s.rows[Math.max(0, s.rows.length - 2)]?.payment ?? s.initialPayment;
  return {
    baseline: { payoffDate: base.payoffDate, months: base.rows.length, totalInterest: base.totalInterest, payment: lastPayment(base) },
    scenario: { payoffDate: sc.payoffDate, months: sc.rows.length, totalInterest: sc.totalInterest, payment: lastPayment(sc) },
    interestSaved: base.totalInterest - sc.totalInterest,
    monthsSaved: base.rows.length - sc.rows.length,
    scenarioSchedule: sc,
  };
}

/** Convenience: what-if extra monthly principal only. */
export function whatIfExtraMonthly(loan: LoanTerms, extraMonthly: Milli, existingEvents: LoanEvent[] = []): WhatIfResult {
  return whatIf(loan, existingEvents, { extraMonthly });
}
