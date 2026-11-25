/** Scheduled-transaction occurrence generation (for upcoming amounts, §6.5). */
import { addDays, addMonths, daysInMonth, lastDayOfMonth, monthOf } from "@homebase/shared";
import type { EngineScheduledTransaction, ISODate, Month } from "./types";

function withDay(month: Month, day: number): ISODate {
  const d = Math.min(Math.max(day, 1), daysInMonth(month));
  return `${month.slice(0, 8)}${String(d).padStart(2, "0")}`;
}

/**
 * All occurrence dates of `s` from its `nextDate` up to and including `until`
 * (and its `endDate`). Month-based frequencies keep the day of `nextDate`, clamped to month end.
 * `twice_monthly` (YNAB "twiceAMonth"): the anchor day and the day 15 days apart in the same month.
 */
export function occurrences(s: EngineScheduledTransaction, until: ISODate): ISODate[] {
  const end = s.endDate && s.endDate < until ? s.endDate : until;
  const out: ISODate[] = [];
  const start = s.nextDate;
  if (start > end) return out;
  const MAX = 5000;
  const dayStep: Partial<Record<string, number>> = { daily: 1, weekly: 7, biweekly: 14, every_4_weeks: 28 };
  const monthStep: Partial<Record<string, number>> = {
    monthly: 1,
    every_other_month: 2,
    every_3_months: 3,
    every_4_months: 4,
    twice_yearly: 6,
    yearly: 12,
    every_other_year: 24,
  };
  if (s.frequency === "once") return [start];
  const ds = dayStep[s.frequency];
  if (ds !== undefined) {
    for (let d = start, i = 0; d <= end && i < MAX; d = addDays(d, ds), i++) out.push(d);
    return out;
  }
  const ms = monthStep[s.frequency];
  const anchorDay = Number(start.slice(8, 10));
  if (ms !== undefined) {
    for (let m = monthOf(start), i = 0; i < MAX; m = addMonths(m, ms), i++) {
      const d = withDay(m, anchorDay);
      if (d > end) break;
      if (d >= start) out.push(d);
    }
    return out;
  }
  // twice_monthly
  const other = anchorDay <= 15 ? anchorDay + 15 : anchorDay - 15;
  const days = [anchorDay, other].sort((a, b) => a - b);
  for (let m = monthOf(start), i = 0; i < MAX; m = addMonths(m, 1), i++) {
    if (`${m}` > end) break;
    for (const day of days) {
      // a "15 days later" date past month end clamps to the last day
      const d = day > daysInMonth(m) ? lastDayOfMonth(m) : withDay(m, day);
      if (d >= start && d <= end && !out.includes(d)) out.push(d);
    }
  }
  return out;
}

/** Occurrence dates falling in `month`. */
export function occurrencesInMonth(s: EngineScheduledTransaction, month: Month): ISODate[] {
  return occurrences(s, lastDayOfMonth(month)).filter((d) => monthOf(d) === month);
}
