/**
 * Reflect tab math (pure, unit-tested). Money is bigint milliunits. Colors follow the bucket, not its
 * rank in a month: the window's 7 biggest buckets own the 7 categorical slots, everything else is "Other".
 */
import type { Milli, Month } from "@homebase/shared";
import type { ReflectBucket, ReflectData } from "@homebase/core";

export const SLOTS = 7;

/** Bucket id → color slot (1..7) for the window's biggest buckets by total spending. */
export function colorSlots(buckets: readonly ReflectBucket[], slots = SLOTS): Map<string, number> {
  const ranked = [...buckets].filter((b) => b.total > 0n).sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : a.name.localeCompare(b.name)));
  return new Map(ranked.slice(0, slots).map((b, i) => [b.id, i + 1] as const));
}

export const slotColor = (slot: number | null | undefined): string => (slot ? `var(--cat-${slot})` : "var(--cat-other)");

export interface MonthBucket {
  id: string;
  name: string;
  icon: string | null;
  groupName: string;
  spent: Milli;
  /** spent ÷ month total, 0..1. */
  share: number;
  slot: number | null;
}

export interface Slice {
  /** A bucket id, or "other". */
  id: string;
  name: string;
  value: Milli;
  share: number;
  slot: number | null;
}

const share = (v: Milli, total: Milli) => (total > 0n ? Number((v * 10_000n) / total) / 10_000 : 0);
const desc = (a: { spent: Milli; name: string }, b: { spent: Milli; name: string }) => (b.spent > a.spent ? 1 : b.spent < a.spent ? -1 : a.name.localeCompare(b.name));

/** Every bucket that spent money in month `i`, biggest first (net refunds left out). */
export function monthBuckets(data: Pick<ReflectData, "buckets">, i: number, slots = colorSlots(data.buckets)): MonthBucket[] {
  const rows = data.buckets.filter((b) => (b.spent[i] ?? 0n) > 0n).map((b) => ({ id: b.id, name: b.name, icon: b.icon, groupName: b.groupName, spent: b.spent[i]!, share: 0, slot: slots.get(b.id) ?? null }));
  const total = rows.reduce((a, r) => a + r.spent, 0n);
  return rows.map((r) => ({ ...r, share: share(r.spent, total) })).sort(desc);
}

/** Donut slices for month `i`: the slotted buckets that spent, then one "Other" for the rest. */
export function donutSlices(rows: readonly MonthBucket[]): { slices: Slice[]; total: Milli } {
  const total = rows.reduce((a, r) => a + r.spent, 0n);
  const slices: Slice[] = rows.filter((r) => r.slot !== null).map((r) => ({ id: r.id, name: r.name, value: r.spent, share: share(r.spent, total), slot: r.slot }));
  const other = rows.filter((r) => r.slot === null).reduce((a, r) => a + r.spent, 0n);
  if (other > 0n) slices.push({ id: "other", name: "Everything else", value: other, share: share(other, total), slot: null });
  return { slices, total };
}

/** Index of the first month with any spending or income (earlier months are before the history starts). */
export function firstActive(data: Pick<ReflectData, "spent" | "income">): number {
  const i = data.spent.findIndex((v, k) => v !== 0n || data.income[k] !== 0n);
  return i < 0 ? data.spent.length - 1 : i;
}

/** Average of `values` over [from, to) (bigint, rounded down); null when the range is empty. */
export function average(values: readonly Milli[], from: number, to: number): Milli | null {
  if (to <= from) return null;
  let s = 0n;
  for (let k = from; k < to; k++) s += values[k] ?? 0n;
  return s / BigInt(to - from);
}

export interface MonthSummary {
  spent: Milli;
  income: Milli;
  /** income − spent (negative: spent more than came in). */
  kept: Milli;
  /** Average monthly spending over the earlier months in the window (null without any). */
  usual: Milli | null;
}

export function monthSummary(data: Pick<ReflectData, "spent" | "income">, i: number): MonthSummary {
  const spent = data.spent[i] ?? 0n;
  const income = data.income[i] ?? 0n;
  return { spent, income, kept: income - spent, usual: average(data.spent, Math.min(firstActive(data), i), i) };
}

export interface BucketStats {
  /** Average per month from the bucket's first month with spending through month `i`. */
  average: Milli;
  highest: { month: Month; spent: Milli } | null;
  /** Σ over the window. */
  total: Milli;
}

export function bucketStats(b: Pick<ReflectBucket, "spent" | "total">, months: readonly Month[], i: number): BucketStats {
  const start = b.spent.findIndex((v) => v !== 0n);
  const from = start < 0 ? i : Math.min(start, i);
  let highest: BucketStats["highest"] = null;
  b.spent.forEach((v, k) => {
    if (v > 0n && (!highest || v > highest.spent)) highest = { month: months[k]!, spent: v };
  });
  return { average: average(b.spent, from, i + 1) ?? 0n, highest, total: b.total };
}

/** A tidy axis maximum (1, 2, 2.5 or 5 × 10ⁿ dollars) at or above `max`, in milliunits. */
export function niceMax(max: Milli): Milli {
  if (max <= 0n) return 100_000n;
  const dollars = Number(max) / 1000;
  const p = 10 ** Math.floor(Math.log10(dollars));
  const step = [1, 2, 2.5, 5, 10].find((f) => f * p >= dollars) ?? 10;
  return BigInt(Math.round(step * p * 1000));
}

/**
 * The bar chart's axis: normally `niceMax` of everything shown. When one month towers over the rest
 * (more than 2.5× the next highest, e.g. one big purchase), the axis fits the others and that month is
 * drawn clipped with its real total labeled, so one outlier doesn't flatten every other bar.
 */
export function barAxis(values: readonly Milli[], extras: readonly Milli[] = []): { max: Milli; clipped: number[] } {
  const ranked = values.map((v, i) => ({ v, i })).sort((a, b) => (b.v > a.v ? 1 : b.v < a.v ? -1 : 0));
  const top = ranked[0];
  const next = ranked[1]?.v ?? 0n;
  const extra = extras.reduce((a, v) => (v > a ? v : a), 0n);
  if (top && next > 0n && top.v * 2n > next * 5n) {
    const max = niceMax((next > extra ? next : extra) + next / 10n);
    return { max, clipped: top.v > max ? [top.i] : [] };
  }
  const peak = [top?.v ?? 0n, extra].reduce((a, v) => (v > a ? v : a), 0n);
  return { max: niceMax(peak), clipped: [] };
}
