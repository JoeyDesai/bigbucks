/**
 * Report tables (the list under every chart, and the CSV export), drill-down to transactions, and CSV.
 */
import type { ISODate, Milli } from "@homebase/shared";
import type { TransactionFilters } from "../transactions/list";
import type { ReportParams, ResolvedPeriod } from "./params";

/** money = bigint milli; bps = basis points (1234 = 12.34%); days = whole days; count = integer. */
export type CellKind = "text" | "money" | "bps" | "count" | "days" | "date" | "month";
export type Cell = string | number | bigint | null;

export interface TableColumn {
  key: string;
  label: string;
  kind: CellKind;
  /** Hidden on phones (shown on desktop and in the CSV). */
  secondary?: boolean;
  /** Only in the CSV (e.g. one column per month). */
  csvOnly?: boolean;
  /** Money that reads as a gain or loss (green / red). */
  signed?: boolean;
}

/** What a row (or chart mark) drills into. Everything is optional; the report's period fills the dates. */
export interface DrillTarget {
  categoryIds?: string[];
  payeeIds?: string[];
  accountIds?: string[];
  from?: ISODate;
  to?: ISODate;
}

export interface TableRow {
  key: string;
  cells: Record<string, Cell>;
  drill?: DrillTarget;
}

export interface ReportTable {
  columns: TableColumn[];
  rows: TableRow[];
  /** Optional totals row (same keys as cells). */
  total?: Record<string, Cell>;
}

// ── drill-down ──────────────────────────────────────────────────────────────

export interface DrillDown {
  /** Filters for `listTransactions`. */
  filters: TransactionFilters;
  /** Query for the Activity page: `category` (comma-separated ids), `payee`, `from`, `to`, `account`. */
  query: Record<string, string>;
  href: string;
}

/**
 * Turn a report row's drill target into transaction filters and an `/activity?…` link.
 * `key` may also be a string: `category:<id>`, `payee:<id>`, `account:<id>` or `month:YYYY-MM-01`.
 */
export function drillDown(report: string, key: DrillTarget | string, params: Pick<ReportParams, "accountIds"> & { period: Pick<ResolvedPeriod, "from" | "to"> }): DrillDown {
  const t: DrillTarget = typeof key === "string" ? parseDrillKey(key) : key;
  const from = t.from ?? params.period.from;
  const to = t.to ?? params.period.to;
  const accountIds = t.accountIds?.length ? t.accountIds : params.accountIds;
  const filters: TransactionFilters = { dateFrom: from, dateTo: to };
  if (t.categoryIds?.length) filters.categoryIds = t.categoryIds;
  if (t.payeeIds?.length) filters.payeeIds = t.payeeIds;
  if (accountIds?.length) filters.accountIds = accountIds;
  const query: Record<string, string> = {};
  if (t.categoryIds?.length) query.category = t.categoryIds.join(",");
  if (t.payeeIds?.length) query.payee = t.payeeIds.join(",");
  query.from = from;
  query.to = to;
  if (accountIds?.length) query.account = accountIds.join(",");
  return { filters, query, href: `/activity?${new URLSearchParams(query).toString()}` };
}

function lastDay(month: string): ISODate {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month.slice(0, 8)}${String(d).padStart(2, "0")}`;
}

export function parseDrillKey(key: string): DrillTarget {
  const t: DrillTarget = {};
  for (const part of key.split("|")) {
    const i = part.indexOf(":");
    const kind = part.slice(0, i);
    const v = part.slice(i + 1);
    if (kind === "category") t.categoryIds = v.split(",");
    else if (kind === "payee") t.payeeIds = v.split(",");
    else if (kind === "account") t.accountIds = v.split(",");
    else if (kind === "month") {
      t.from = v;
      t.to = lastDay(v);
    }
  }
  return t;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

/** Milli → plain decimal dollars with cents ("-1234.56"); exact, no floats. */
export function milliToDecimal(m: Milli): string {
  const neg = m < 0n;
  const a = neg ? -m : m;
  const cents = (a + 5n) / 10n;
  return `${neg && cents > 0n ? "-" : ""}${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function bpsToPercent(n: number): string {
  const neg = n < 0;
  const a = Math.abs(Math.round(n));
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

function csvCell(v: Cell, kind: CellKind | undefined): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (typeof v === "bigint") s = kind === "money" || kind === undefined ? milliToDecimal(v) : v.toString();
  else if (typeof v === "number") s = kind === "bps" ? bpsToPercent(v) : String(v);
  else s = neutralizeFormula(v);
  return /[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV formula injection (OWASP): a TEXT cell starting with = + - @ tab or CR is run as a formula by
 * Excel / Numbers / Sheets (payee and memo text comes from banks and merchants). Prefix a `'` so it
 * stays text. Only strings: money and other numeric cells are rendered from bigint/number above, so
 * they stay numbers; a string that is just a signed decimal is left alone too.
 */
export function neutralizeFormula(s: string): string {
  if (/^-?\d+(\.\d+)?$/.test(s)) return s; // a plain negative number ("-12.50", e.g. a saved table's cell) is not a formula
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/**
 * CSV (RFC 4180, CRLF) from a report table or plain records. Money (bigint milli) becomes decimal
 * dollars, basis points become percent with two decimals. Plain records: bigint is treated as money.
 */
export function toCsv(input: ReportTable | Record<string, Cell>[]): string {
  let columns: { key: string; label: string; kind?: CellKind }[];
  let rows: Record<string, Cell>[];
  if (Array.isArray(input)) {
    const keys: string[] = [];
    for (const r of input) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
    columns = keys.map((k) => ({ key: k, label: k }));
    rows = input;
  } else {
    columns = input.columns;
    rows = input.rows.map((r) => r.cells);
    if (input.total) rows = [...rows, input.total];
  }
  const lines = [columns.map((c) => csvCell(c.label, "text")).join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c.key] ?? null, c.kind)).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** Share of `part` in `whole`, in basis points (0 when whole is 0). */
export function bps(part: Milli, whole: Milli): number {
  if (whole === 0n) return 0;
  return Number((part * 10_000n) / whole);
}
