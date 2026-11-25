/**
 * Age of Money (§6.7): cash inflows are FIFO buckets; each cash outflow consumes the oldest buckets
 * first. Card payments count as outflows (that is how card spending enters AoM once paid).
 * Transfers between two on-budget cash accounts are excluded; starting balances are never
 * outflows (and are buckets unless `includeStartingBalances: false`).
 * AoM = mean age (days, rounded) of the money used by the last 10 qualifying outflows; null until 10 exist.
 * Each outflow's age is the amount-weighted age of the buckets it consumed; money with no bucket
 * (overdraft) counts as 0 days old.
 */
import { daysBetween, lastDayOfMonth, monthOf } from "@homebase/shared";
import { buildLedger, type Ledger } from "./ledger";
import type { BudgetSnapshot, ISODate, Milli, Month } from "./types";

export interface AgeOfMoneyOutflow {
  txnId: string;
  date: ISODate;
  amount: Milli;
  /** Amount-weighted age in milli-days (days × 1000), floor. */
  ageMilliDays: bigint;
}

export interface AgeOfMoneyOptions {
  asOf?: ISODate;
  includeStartingBalances?: boolean;
  /** Number of most recent outflows averaged (YNAB: 10). */
  window?: number;
}

/** Every qualifying outflow with the age of the money it used, in date order. */
export function ageOfMoneyOutflows(ledger: Ledger, opts: AgeOfMoneyOptions = {}): AgeOfMoneyOutflow[] {
  const includeSB = opts.includeStartingBalances ?? true;
  const buckets: { date: ISODate; remaining: Milli }[] = [];
  let head = 0;
  const out: AgeOfMoneyOutflow[] = [];
  for (const l of ledger.lines) {
    if (l.onCredit) continue;
    const cashTransfer = l.transferOnBudget && !l.transferIsCredit;
    if (cashTransfer || l.amount === 0n) continue;
    if (l.amount > 0n) {
      if (l.isStartingBalance && !includeSB) continue;
      buckets.push({ date: l.date, remaining: l.amount });
      continue;
    }
    if (l.isStartingBalance) continue;
    const A = -l.amount;
    let need = A;
    let weighted = 0n;
    while (need > 0n && head < buckets.length) {
      const b = buckets[head]!;
      const take = b.remaining < need ? b.remaining : need;
      weighted += take * BigInt(Math.max(0, daysBetween(b.date, l.date)));
      b.remaining -= take;
      need -= take;
      if (b.remaining === 0n) head++;
    }
    out.push({ txnId: l.txnId, date: l.date, amount: A, ageMilliDays: (weighted * 1000n) / A });
  }
  return out;
}

/** Mean age in whole days, rounded half up (closer to YNAB than flooring; ADR-E9). */
function meanDays(xs: AgeOfMoneyOutflow[]): number {
  let s = 0n;
  for (const x of xs) s += x.ageMilliDays;
  return Number((s / BigInt(xs.length) + 500n) / 1000n);
}

/** AoM as of the end of each month (or `asOf` if earlier). */
export function computeAgeOfMoneyByMonth(ledger: Ledger, months: Month[], opts: AgeOfMoneyOptions = {}): Map<Month, number | null> {
  const window = opts.window ?? 10;
  const outflows = ageOfMoneyOutflows(ledger, opts);
  const res = new Map<Month, number | null>();
  let i = 0;
  for (const M of months) {
    let cutoff = lastDayOfMonth(M);
    if (opts.asOf && opts.asOf < cutoff) cutoff = opts.asOf;
    if (opts.asOf && monthOf(opts.asOf) < M) {
      res.set(M, null);
      continue;
    }
    while (i < outflows.length && outflows[i]!.date <= cutoff) i++;
    res.set(M, i >= window ? meanDays(outflows.slice(i - window, i)) : null);
  }
  return res;
}

/** Age of Money for a snapshot as of `asOf` (default: all data). */
export function computeAgeOfMoney(snapshot: BudgetSnapshot, opts: AgeOfMoneyOptions = {}): number | null {
  const ledger = buildLedger(snapshot, { cardStartingDebt: "no_budget_effect" });
  const window = opts.window ?? 10;
  const outflows = ageOfMoneyOutflows(ledger, opts).filter((o) => !opts.asOf || o.date <= opts.asOf);
  return outflows.length >= window ? meanDays(outflows.slice(-window)) : null;
}
