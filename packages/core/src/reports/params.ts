/**
 * Common report parameters (spec §13: period, account and entity filters, category or group level),
 * their URL form, and period resolution. Pure: no database access.
 */
import { z } from "zod";
import { addMonths, daysBetween, formatMonth, lastDayOfMonth, monthOf, monthRange, today as localToday, type ISODate, type Month } from "@homebase/shared";
import { ValidationError } from "../errors";

export const REPORT_SLUGS = [
  "spending-breakdown",
  "spending-trends",
  "income-vs-expense",
  "net-worth",
  "age-of-money",
  "category-detail",
  "payees",
  "cash-flow",
  "investment-growth",
  "budget-performance",
  "subscriptions",
  "saved",
] as const;
export type ReportSlug = (typeof REPORT_SLUGS)[number];

export const PERIOD_KINDS = ["month", "quarter", "ytd", "last12", "custom"] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];
export const ENTITIES = ["household", "business", "all"] as const;
export type ReportEntity = (typeof ENTITIES)[number];
/** Also accepted: "ridgeline", the business key in reports saved and links made before it was renamed. */
const ENTITY_INPUTS = [...ENTITIES, "ridgeline"] as const;
const EntitySchema = z.enum(ENTITY_INPUTS).transform((e): ReportEntity => (e === "ridgeline" ? "business" : e));
export const LEVELS = ["category", "group"] as const;
export type ReportLevel = (typeof LEVELS)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const monthStr = z.string().regex(/^\d{4}-\d{2}-01$/);

export const ReportParamsSchema = z.object({
  period: z.enum(PERIOD_KINDS).default("month"),
  /** Anchor month for `month` / `quarter` (default: the current month). */
  month: monthStr.optional(),
  /** `custom` range (inclusive). `to` defaults to today. */
  from: isoDate.optional(),
  to: isoDate.optional(),
  accountIds: z.array(z.string().uuid()).max(100).optional(),
  entity: EntitySchema.default("household"),
  level: z.enum(LEVELS).default("category"),
  /** Category detail: the category (or, at group level, the group) to show. */
  categoryId: z.string().uuid().optional(),
  /** Investment growth: a single account (default: every investment account in scope). */
  accountId: z.string().uuid().optional(),
  /** "Today" in America/New_York (tests and jobs pin it). */
  today: isoDate.optional(),
});
export type ReportParams = z.output<typeof ReportParamsSchema>;

/** The same fields, all optional and without defaults (saved report references). */
export const ReportParamsPartialSchema = z.object({
  period: z.enum(PERIOD_KINDS).optional(),
  month: monthStr.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  accountIds: z.array(z.string().uuid()).max(100).optional(),
  entity: EntitySchema.optional(),
  level: z.enum(LEVELS).optional(),
  categoryId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
});
export type ReportParamsInput = z.input<typeof ReportParamsSchema>;

export function reportParams(input: ReportParamsInput = {}): ReportParams {
  return ReportParamsSchema.parse(input);
}

type SearchLike = Record<string, string | string[] | undefined> | URLSearchParams;

function getParam(s: SearchLike, k: string): string | undefined {
  if (s instanceof URLSearchParams) return s.get(k) ?? undefined;
  const v = s[k];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Parse URL search params (`?period=&m=YYYY-MM&from=&to=&entity=&level=&accounts=a,b&category=&account=`).
 * Invalid values fall back to the defaults (`defaults` first, then the schema's), never throw.
 */
export function paramsFromSearch(search: SearchLike, defaults: Partial<ReportParams> = {}): ReportParams {
  const pick = <T extends string>(k: string, allowed: readonly T[]): T | undefined => {
    const v = getParam(search, k);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
  };
  const m = getParam(search, "m");
  const month = m && /^\d{4}-\d{2}$/.test(m) ? `${m}-01` : m && /^\d{4}-\d{2}-01$/.test(m) ? m : undefined;
  const date = (k: string) => {
    const v = getParam(search, k);
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined;
  };
  const uuid = (v: string | undefined) => (v && z.string().uuid().safeParse(v).success ? v : undefined);
  const accounts = (getParam(search, "accounts") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => z.string().uuid().safeParse(s).success);
  let period = pick("period", PERIOD_KINDS) ?? defaults.period;
  const from = date("from");
  if (period === "custom" && !from) period = defaults.period && defaults.period !== "custom" ? defaults.period : "month";
  return ReportParamsSchema.parse({
    ...defaults,
    period,
    month: month ?? defaults.month,
    from: period === "custom" ? from : undefined,
    to: period === "custom" ? date("to") : undefined,
    entity: pick("entity", ENTITY_INPUTS) ?? defaults.entity,
    level: pick("level", LEVELS) ?? defaults.level,
    accountIds: accounts.length ? accounts : defaults.accountIds,
    categoryId: uuid(getParam(search, "category")) ?? defaults.categoryId,
    accountId: uuid(getParam(search, "account")) ?? defaults.accountId,
  });
}

/**
 * The inverse of `paramsFromSearch` (omits defaults to keep URLs short). Pass the same `defaults`
 * the reading side uses (e.g. a report's default period), or every value is written.
 */
export function paramsToSearch(p: Partial<ReportParams>, defaults: Partial<Pick<ReportParams, "period" | "level">> = { period: "month", level: "category" }): URLSearchParams {
  const s = new URLSearchParams();
  if (p.period && p.period !== defaults.period) s.set("period", p.period);
  if (p.month && (p.period === "month" || p.period === "quarter" || !p.period)) s.set("m", p.month.slice(0, 7));
  if (p.period === "custom") {
    if (p.from) s.set("from", p.from);
    if (p.to) s.set("to", p.to);
  }
  if (p.entity && p.entity !== "household") s.set("entity", p.entity);
  if (p.level && p.level !== defaults.level) s.set("level", p.level);
  if (p.accountIds?.length) s.set("accounts", p.accountIds.join(","));
  if (p.categoryId) s.set("category", p.categoryId);
  if (p.accountId) s.set("account", p.accountId);
  return s;
}

// ── periods ─────────────────────────────────────────────────────────────────

export interface ResolvedPeriod {
  kind: PeriodKind;
  from: ISODate;
  /** Inclusive; capped at today for the current month / quarter / year. */
  to: ISODate;
  /** Every month touched by [from, to]. */
  months: Month[];
  /** Days in [from, to]. */
  days: number;
  label: string;
  /** Anchor month (month / quarter) for prev/next stepping. */
  anchor: Month;
  today: ISODate;
}

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatShortDate(d: ISODate, withYear = true): string {
  const s = `${SHORT[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
  return withYear ? `${s}, ${d.slice(0, 4)}` : s;
}

export function quarterStart(m: Month): Month {
  const q = Math.floor((Number(m.slice(5, 7)) - 1) / 3) * 3 + 1;
  return `${m.slice(0, 4)}-${String(q).padStart(2, "0")}-01`;
}

export function resolvePeriod(p: Pick<ReportParams, "period" | "month" | "from" | "to" | "today">): ResolvedPeriod {
  const today = p.today ?? localToday();
  const cur = monthOf(today);
  const cap = (d: ISODate) => (d > today ? today : d);
  let from: ISODate;
  let to: ISODate;
  let label: string;
  let anchor = p.month ?? cur;
  switch (p.period) {
    case "month": {
      from = anchor;
      to = anchor > cur ? lastDayOfMonth(anchor) : cap(lastDayOfMonth(anchor));
      label = formatMonth(anchor);
      break;
    }
    case "quarter": {
      const qs = quarterStart(anchor);
      anchor = qs;
      from = qs;
      const end = lastDayOfMonth(addMonths(qs, 2));
      to = qs > cur ? end : cap(end);
      label = `Q${(Number(qs.slice(5, 7)) + 2) / 3} ${qs.slice(0, 4)}`;
      break;
    }
    case "ytd": {
      from = `${today.slice(0, 4)}-01-01`;
      to = today;
      anchor = cur;
      label = `${today.slice(0, 4)} to date`;
      break;
    }
    case "last12": {
      from = addMonths(cur, -11);
      to = today;
      anchor = cur;
      label = "Last 12 months";
      break;
    }
    case "custom": {
      if (!p.from) throw new ValidationError("a custom period needs a start date");
      from = p.from;
      to = p.to ?? today;
      if (from > to) throw new ValidationError("the period starts after it ends");
      anchor = monthOf(to);
      label = from.slice(0, 4) === to.slice(0, 4) ? `${formatShortDate(from, false)} – ${formatShortDate(to)}` : `${formatShortDate(from)} – ${formatShortDate(to)}`;
      break;
    }
  }
  return { kind: p.period, from, to, months: monthRange(monthOf(from), monthOf(to)), days: daysBetween(from, to) + 1, label, anchor, today };
}

/** Step a month/quarter anchor (for prev/next controls). */
export function stepAnchor(kind: PeriodKind, anchor: Month, dir: -1 | 1): Month {
  return addMonths(anchor, kind === "quarter" ? dir * 3 : dir);
}
