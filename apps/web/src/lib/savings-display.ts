/**
 * What a savings bucket says (pure, unit-tested; ADR "Buckets: savings buckets"). Money is bigint
 * milliunits. A savings bucket shows its balance, and progress toward its target when it has one.
 */
import { divRound, formatMilli, type Milli } from "@homebase/shared";
import type { BucketSavings, SavingsBucketInfo } from "@homebase/core";
import type { BarModel } from "@/components/glow/BucketBar";

/** Quick amounts in the Add popover. */
export const QUICK_AMOUNTS: readonly Milli[] = [100_000n, 250_000n, 500_000n, 1_000_000n];

/** Whole dollars, rounded ($79.99 → $80); negative keeps its sign. */
export function wholeDollars(m: Milli): string {
  const abs = divRound(m < 0n ? -m : m, 1000n) * 1000n;
  return `${m < 0n && abs > 0n ? "−" : ""}${formatMilli(abs, { cents: false })}`;
}

export interface SavingsDisplay {
  balance: Milli;
  /** "$2,400 of $15,000 · 16%" with a target; else "Saved" / "Starts in …". */
  detail: string;
  /** Progress bar toward the target (null without one). */
  bar: BarModel | null;
  /** 0..100, null without a target. */
  percent: number | null;
  /** Spent more than it had: the balance is below zero. */
  negative: boolean;
  /** Screen-reader summary. */
  label: string;
  /** Reached (or passed) the target. */
  reached: boolean;
}

type Info = Pick<SavingsBucketInfo, "balance" | "target" | "progress"> & Partial<Pick<SavingsBucketInfo, "started" | "from">>;

export function savingsDisplay(name: string, s: Info, opts: { monthLabel?: (m: string) => string } = {}): SavingsDisplay {
  const negative = s.balance < 0n;
  if (s.started === false) {
    const when = s.from ? (opts.monthLabel?.(s.from) ?? s.from) : "";
    return { balance: 0n, detail: when ? `Starts in ${when}` : "Not started", bar: null, percent: null, negative: false, label: `${name}: not saving yet`, reached: false };
  }
  if (s.target !== null && s.target > 0n) {
    const p = s.progress ?? 0;
    const pct = Math.floor(p * 100);
    const reached = s.balance >= s.target;
    return {
      balance: s.balance,
      detail: `${wholeDollars(s.balance)} of ${wholeDollars(s.target)} · ${reached ? "100" : pct}%`,
      bar: { state: "under", fill: p, over: 0 },
      percent: reached ? 100 : pct,
      negative,
      label: `${name}: ${formatMilli(s.balance)} saved of ${formatMilli(s.target)}`,
      reached,
    };
  }
  return { balance: s.balance, detail: negative ? "Spent more than it had" : "Saved", bar: null, percent: null, negative, label: `${name}: ${formatMilli(s.balance)} saved`, reached: false };
}

/** "Income this month $8,240 · $1,250 added to savings" (or "· $300 taken out of savings"). */
export function incomeLine(income: Milli, added: Milli, current = true): string {
  const when = current ? "this month" : "that month";
  const head = `Income ${when} ${wholeDollars(income > 0n ? income : 0n)}`;
  if (added === 0n) return `${head} · nothing added to savings yet`;
  return added > 0n ? `${head} · ${wholeDollars(added)} added to savings` : `${head} · ${wholeDollars(-added)} taken out of savings`;
}

/** The savings section with `delta` added to one bucket (the optimistic update while the add is saving). */
export function withSavingsDelta(s: BucketSavings, categoryId: string, delta: Milli): BucketSavings {
  if (delta === 0n) return s;
  let hit = false;
  const rows = s.rows.map((r) => {
    if (r.id !== categoryId || !r.savings) return r;
    hit = true;
    const balance = r.savings.balance + delta;
    const target = r.savings.target;
    const progress = target !== null && target > 0n ? Math.max(0, Math.min(1, Number((balance * 10_000n) / target) / 10_000)) : null;
    return {
      ...r,
      remaining: balance,
      bar: progress === null ? r.bar : { ...r.bar, state: "under" as const, fill: progress, remaining: balance },
      savings: { ...r.savings, balance, contributed: r.savings.contributed + delta, progress },
    };
  });
  if (!hit) return s;
  const ready = s.ready && { ...s.ready, inSavings: s.ready.inSavings + delta, amount: s.ready.amount - delta };
  return { ...s, rows, totalSaved: s.totalSaved + delta, addedToSavings: s.addedToSavings + delta, ready };
}

/** "Ready to save $8,947" / "Buckets hold $300 more than you have". */
export function readyLine(amount: Milli): { label: string; amount: string; over: boolean } {
  return amount < 0n ? { label: "Buckets hold more than you have by", amount: wholeDollars(-amount), over: true } : { label: "Ready to save", amount: wholeDollars(amount), over: false };
}

/** The warning for adding `amount` when only `ready` is in no bucket (null when it fits). */
export function overReadyWarning(amount: Milli, ready: Milli): string | null {
  if (amount <= 0n || amount <= ready) return null;
  const left = ready > 0n ? ready : 0n;
  return `That's ${formatMilli(amount - left)} more than you have ready to save (${formatMilli(left)} isn't in a bucket yet).`;
}

/**
 * The add / take-out to send: `amount` is what was typed (positive); taking out is refused when it is
 * more than the balance. Returns the signed amount or the reason it can't be sent.
 */
export function savingsChange(amount: Milli | null, takeOut: boolean, balance: Milli): { amount: Milli } | { error: string } {
  if (amount === null || amount <= 0n) return { error: "Enter an amount" };
  if (takeOut && amount > (balance > 0n ? balance : 0n)) return { error: `Only ${formatMilli(balance > 0n ? balance : 0n)} to take out` };
  return { amount: takeOut ? -amount : amount };
}
