/**
 * Client-safe mirror of core's report URL params (`paramsToSearch` in @homebase/core, which can't be
 * imported into client components because it pulls in pg). Keep the two in step.
 */
export type PeriodKind = "month" | "quarter" | "ytd" | "last12" | "custom";
export type ReportEntity = "household" | "business" | "all";
export type ReportLevel = "category" | "group";

export interface UrlParams {
  period: PeriodKind;
  month?: string;
  from?: string;
  to?: string;
  accountIds?: string[];
  entity: ReportEntity;
  level: ReportLevel;
  categoryId?: string;
  accountId?: string;
}

/** `defaults` must match the report's defaults on the server (core `reportDefaults`). */
export function toSearch(p: UrlParams, defaults: { period: PeriodKind; level: ReportLevel } = { period: "month", level: "category" }): string {
  const s = new URLSearchParams();
  if (p.period !== defaults.period) s.set("period", p.period);
  if (p.month && (p.period === "month" || p.period === "quarter")) s.set("m", p.month.slice(0, 7));
  if (p.period === "custom") {
    if (p.from) s.set("from", p.from);
    if (p.to) s.set("to", p.to);
  }
  if (p.entity !== "household") s.set("entity", p.entity);
  if (p.level !== defaults.level) s.set("level", p.level);
  if (p.accountIds?.length) s.set("accounts", p.accountIds.join(","));
  if (p.categoryId) s.set("category", p.categoryId);
  if (p.accountId) s.set("account", p.accountId);
  const q = s.toString();
  return q ? `?${q}` : "";
}

export function addMonths(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}-01`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10-01" → "Oct 2026" (short) / "October 2026". */
export function monthLabel(month: string, style: "short" | "long" = "short"): string {
  const i = Number(month.slice(5, 7)) - 1;
  return `${(style === "long" ? LONG : MONTHS)[i]} ${month.slice(0, 4)}`;
}

/** "2026-10-21" → "Oct 21, 2026" (or without the year). */
export function dayLabel(date: string, withYear = true): string {
  const s = `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
  return withYear ? `${s}, ${date.slice(0, 4)}` : s;
}

/** Basis points → "12.3%". */
export function bpsLabel(bps: number, digits = 1): string {
  return `${(bps / 100).toFixed(digits)}%`;
}
