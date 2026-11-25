import { formatMilli, milliToNumber } from "@homebase/shared";

/** bigint milli → number for chart geometry only (display edge; never fed back into math). */
export const toChartNumber = (m: bigint): number => milliToNumber(m);

/** Tooltip text for a chart number (dollars). */
export function fmtDollars(n: number, cents = true): string {
  return formatMilli(BigInt(Math.round(n * 1000)), { cents });
}

/** Compact axis ticks: $850, $3.2k, $1.4M. */
export function fmtCompact(n: number): string {
  const a = Math.abs(n);
  const s = n < 0 ? "-" : "";
  if (a >= 1_000_000) return `${s}$${(a / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 1_000) return `${s}$${(a / 1_000).toFixed(a >= 10_000 ? 0 : 1)}k`;
  return `${s}$${Math.round(a)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-01" → "Oct" (or "Oct 26" with year). */
export function fmtMonthTick(month: string, withYear = false): string {
  const m = MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
  return withYear ? `${m} ’${month.slice(2, 4)}` : m;
}
