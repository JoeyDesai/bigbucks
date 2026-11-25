/**
 * Small amortization engine for the mortgage page (spec §7.7), exact in bigint milliunits.
 * NOTE: packages/connectors/src/amortization.ts has a parallel implementation (it feeds the balance
 * snapshots); see ADR "Core: amortization duplicated" — unify when both settle.
 *
 * Interest per period = balance × annual/12, rounded half-up to the milliunit (same convention as the demo
 * seed's mortgage balances). On a date with both a payment and an event, the payment is applied first.
 */
import { addMonths, daysInMonth, divRound, monthOf, type ISODate, type Milli } from "@homebase/shared";

/** Annual rate as a decimal-fraction string ("0.065000" = 6.5%) → parts per 1e9. */
const RATE_SCALE = 1_000_000_000n;
export function parseRate(fraction: string | number): bigint {
  const s = String(fraction).trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new Error(`bad rate ${s}`);
  const frac = (m[2] ?? "").padEnd(9, "0").slice(0, 9);
  return BigInt(m[1] || "0") * RATE_SCALE + BigInt(frac || "0");
}

export const monthlyInterest = (balance: Milli, rate: bigint): Milli => divRound(balance * rate, 12n * RATE_SCALE);

/** Level P&I payment P·r/(1−(1+r)^−n), rounded to cents. */
export function levelPayment(principal: Milli, rate: bigint, months: number): Milli {
  if (months <= 0) return principal;
  if (rate === 0n) return divRound(principal, BigInt(months) * 10n) * 10n;
  const S = 10n ** 18n;
  const r = (rate * S) / (12n * RATE_SCALE);
  let f = S;
  for (let i = 0; i < months; i++) f = (f * (S + r)) / S;
  const pmt = (principal * r * f) / ((f - S) * S);
  return divRound(pmt, 10n) * 10n;
}

export interface LoanTerms {
  principal: Milli;
  /** Decimal fraction, e.g. "0.065". */
  annualRate: string;
  termMonths: number;
  firstPaymentDate: ISODate;
  /** Scheduled P&I payment. */
  payment: Milli;
  escrow: Milli;
}

export interface LoanEventInput {
  date: ISODate;
  kind: "extra_principal" | "recast" | "rate_change" | "statement_balance";
  amount: Milli | null;
  newPayment: Milli | null;
  newRate: string | null;
}

export interface AmortizationRow {
  n: number;
  date: ISODate;
  interest: Milli;
  principal: Milli;
  /** Extra principal paid with this payment (simulation). */
  extra: Milli;
  payment: Milli;
  balance: Milli;
}

export interface AppliedEvent extends LoanEventInput {
  balanceBefore: Milli;
  balanceAfter: Milli;
}

export interface Schedule {
  rows: AmortizationRow[];
  events: AppliedEvent[];
  payoffDate: ISODate | null;
  totalInterest: Milli;
}

export interface ScheduleOptions {
  /** Extra principal with every payment from `extraFrom` on. */
  extraMonthly?: Milli;
  extraFrom?: ISODate;
  /** Additional hypothetical events (lump sums, a recast). */
  extraEvents?: LoanEventInput[];
}

/** The k-th payment date, keeping the first payment's day (clamped to month end). */
export function paymentDate(first: ISODate, k: number): ISODate {
  const m = addMonths(monthOf(first), k);
  const day = Math.min(Number(first.slice(8, 10)), daysInMonth(m));
  return `${m.slice(0, 8)}${String(day).padStart(2, "0")}`;
}

export function buildSchedule(loan: LoanTerms, events: LoanEventInput[] = [], o: ScheduleOptions = {}): Schedule {
  const evs = [...events, ...(o.extraEvents ?? [])].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let rate = parseRate(loan.annualRate);
  let payment = loan.payment;
  let balance = loan.principal;
  let ei = 0;
  const rows: AmortizationRow[] = [];
  const applied: AppliedEvent[] = [];
  let totalInterest = 0n;
  const maxN = loan.termMonths + 240;
  const applyEvent = (e: LoanEventInput, remaining: number) => {
    const before = balance;
    switch (e.kind) {
      case "extra_principal":
        balance -= e.amount ?? 0n;
        break;
      case "statement_balance":
        if (e.amount !== null) balance = e.amount;
        break;
      case "recast":
        balance -= e.amount ?? 0n;
        payment = e.newPayment ?? levelPayment(balance < 0n ? 0n : balance, rate, remaining);
        break;
      case "rate_change":
        if (e.newRate !== null) rate = parseRate(e.newRate);
        payment = e.newPayment ?? levelPayment(balance < 0n ? 0n : balance, rate, remaining);
        break;
    }
    if (balance < 0n) balance = 0n;
    applied.push({ ...e, balanceBefore: before, balanceAfter: balance });
  };
  for (let n = 0; n < maxN && balance > 0n; n++) {
    const date = paymentDate(loan.firstPaymentDate, n);
    while (ei < evs.length && evs[ei]!.date < date) applyEvent(evs[ei++]!, loan.termMonths - n);
    if (balance <= 0n) break;
    const interest = monthlyInterest(balance, rate);
    let principal = payment - interest;
    if (principal > balance) principal = balance;
    if (principal < 0n) principal = 0n;
    balance -= principal;
    let extra = 0n;
    if (o.extraMonthly && o.extraMonthly > 0n && (!o.extraFrom || date >= o.extraFrom)) {
      extra = o.extraMonthly < balance ? o.extraMonthly : balance;
      balance -= extra;
    }
    totalInterest += interest;
    rows.push({ n: n + 1, date, interest, principal, extra, payment: interest + principal + extra, balance });
  }
  while (ei < evs.length && balance > 0n) applyEvent(evs[ei++]!, 0);
  const last = rows[rows.length - 1];
  return { rows, events: applied, payoffDate: balance === 0n && last ? last.date : null, totalInterest };
}

/** Scheduled balance after every payment and event dated ≤ asOf. */
export function balanceAsOf(loan: LoanTerms, schedule: Schedule, asOf: ISODate): Milli {
  let bal = loan.principal;
  let date: ISODate = "0000-00-00";
  for (const r of schedule.rows) if (r.date <= asOf && r.date >= date) {
    bal = r.balance;
    date = r.date;
  }
  // events dated after the last payment ≤ asOf (and ≤ asOf themselves) are applied on top
  for (const e of schedule.events) if (e.date <= asOf && e.date >= date) {
    bal = e.balanceAfter;
    date = e.date;
  }
  return bal;
}

export function interestPaidThrough(schedule: Schedule, asOf: ISODate): Milli {
  let s = 0n;
  for (const r of schedule.rows) if (r.date <= asOf) s += r.interest;
  return s;
}
