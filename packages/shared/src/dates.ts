/**
 * All budget dates are calendar dates in America/New_York, represented as "YYYY-MM-DD" strings.
 * Months are represented as "YYYY-MM-01".
 */
export const TZ = "America/New_York";

export type ISODate = string; // YYYY-MM-DD
export type Month = string; // YYYY-MM-01

const dtf = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** Convert an instant (Date, epoch seconds, or ISO timestamp) to the local calendar date. */
export function toLocalDate(instant: Date | number | string): ISODate {
  const d = typeof instant === "number" ? new Date(instant * 1000) : new Date(instant);
  return dtf.format(d);
}

export function today(): ISODate {
  return toLocalDate(new Date());
}

export function monthOf(date: ISODate): Month {
  return `${date.slice(0, 7)}-01`;
}

export function currentMonth(): Month {
  return monthOf(today());
}

export function addMonths(month: Month, n: number): Month {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}-01`;
}

/** Inclusive count of months from a to b (same month = 1). Negative if b < a. */
export function monthsBetween(a: Month, b: Month): number {
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7))) + 1;
}

export function monthRange(from: Month, to: Month): Month[] {
  const out: Month[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

export function daysInMonth(month: Month): number {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function lastDayOfMonth(month: Month): ISODate {
  return `${month.slice(0, 8)}${String(daysInMonth(month)).padStart(2, "0")}`;
}

export function addDays(date: ISODate, n: number): ISODate {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(date: ISODate): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** Number of times weekday `day` (0=Sun) occurs in month. */
export function weekdayCount(month: Month, day: number): number {
  let n = 0;
  const dim = daysInMonth(month);
  for (let i = 1; i <= dim; i++) if (weekday(`${month.slice(0, 8)}${String(i).padStart(2, "0")}`) === day) n++;
  return n;
}

export function formatMonth(month: Month, style: "long" | "short" = "long"): string {
  const d = new Date(`${month}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { month: style, year: "numeric", timeZone: "UTC" });
}
