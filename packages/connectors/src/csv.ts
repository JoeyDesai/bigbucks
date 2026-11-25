/**
 * Generic CSV importer (§7.10) with a column-mapping config and date-format detection.
 * Output is ExternalTxn[]; duplicate detection against existing rows uses importHash (§8.4).
 */
import { parse } from "csv-parse/sync";
import type { ISODate, Milli } from "@homebase/shared";
import { blankToUndef, importHash, normalizeDescription, toMilli } from "./normalize";
import { ConnectorError, type ExternalTxn } from "./types";

export const DATE_FORMATS = ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "YYYY/MM/DD", "MM-DD-YYYY", "DD.MM.YYYY", "YYYYMMDD", "MMM D, YYYY", "D MMM YYYY"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

/** Column reference: header name (case-insensitive) or 0-based index. */
export type ColumnRef = string | number;

export interface CsvMapping {
  date: ColumnRef;
  /** Single signed amount column … */
  amount?: ColumnRef;
  /** … or separate outflow / inflow columns (both positive numbers). */
  outflow?: ColumnRef;
  inflow?: ColumnRef;
  payee?: ColumnRef;
  memo?: ColumnRef;
  /** Description column; defaults to payee. */
  description?: ColumnRef;
  /** Optional provider id column. */
  externalId?: ColumnRef;
  dateFormat?: DateFormat | "auto";
  /** Flip the sign of `amount` (for exports where purchases are positive, e.g. some card CSVs). */
  invertAmount?: boolean;
  hasHeader?: boolean;
  /** Lines to skip before the header (bank preambles). */
  skipLines?: number;
  delimiter?: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function valid(y: number, mo: number, d: number): ISODate | null {
  if (!(y >= 1900 && y <= 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
const yr = (s: string) => (s.length === 2 ? 2000 + Number(s) : Number(s));

/** Parse one date string with a specific format; null if it doesn't fit. Two-digit years are 20xx. */
export function parseDateWithFormat(raw: string, fmt: DateFormat): ISODate | null {
  const s = raw.trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s*[AP]M)?$/i, "");
  let m: RegExpExecArray | null;
  switch (fmt) {
    case "YYYY-MM-DD":
      m = /^(\d{4})-(\d{1,2})-(\d{1,2})(T.*)?$/.exec(s);
      return m ? valid(+m[1]!, +m[2]!, +m[3]!) : null;
    case "YYYY/MM/DD":
      m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
      return m ? valid(+m[1]!, +m[2]!, +m[3]!) : null;
    case "MM/DD/YYYY":
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
      return m ? valid(yr(m[3]!), +m[1]!, +m[2]!) : null;
    case "DD/MM/YYYY":
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s);
      return m ? valid(yr(m[3]!), +m[2]!, +m[1]!) : null;
    case "MM-DD-YYYY":
      m = /^(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})$/.exec(s);
      return m ? valid(yr(m[3]!), +m[1]!, +m[2]!) : null;
    case "DD.MM.YYYY":
      m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(s);
      return m ? valid(yr(m[3]!), +m[2]!, +m[1]!) : null;
    case "YYYYMMDD":
      m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
      return m ? valid(+m[1]!, +m[2]!, +m[3]!) : null;
    case "MMM D, YYYY": {
      m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
      const mi = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1;
      return m && mi >= 0 ? valid(+m[3]!, mi + 1, +m[2]!) : null;
    }
    case "D MMM YYYY": {
      m = /^(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s-](\d{4})$/.exec(s);
      const mi = m ? MONTHS.indexOf(m[2]!.toLowerCase()) : -1;
      return m && mi >= 0 ? valid(+m[3]!, mi + 1, +m[1]!) : null;
    }
  }
}

/**
 * Pick the first format that parses every non-empty sample. MM/DD vs DD/MM: US order wins unless a
 * sample's first part is > 12. Returns null when nothing fits.
 */
export function detectDateFormat(samples: string[]): DateFormat | null {
  const xs = samples.map((s) => s.trim()).filter(Boolean);
  if (!xs.length) return null;
  for (const f of DATE_FORMATS) if (xs.every((x) => parseDateWithFormat(x, f) !== null)) return f;
  return null;
}

/** "$1,234.56", "-12.00", "(12.00)", "12.00 CR", "12.00 DR", "1.234,56" (EU) → milli. */
export function parseAmountLoose(raw: string): Milli | undefined {
  let s = raw.trim();
  if (!s || s === "-" || s === "--") return undefined;
  let sign = 1n;
  if (/\bCR$/i.test(s)) s = s.replace(/\s*CR$/i, "");
  else if (/\bDR$/i.test(s)) {
    s = s.replace(/\s*DR$/i, "");
    sign = -1n;
  }
  if (/^-?[\d.]+,\d{1,2}$/.test(s.replace(/[$€£\s]/g, ""))) s = s.replace(/\./g, "").replace(",", ".");
  s = s.replace(/[€£]/g, "");
  return sign * toMilli(s);
}

function readRows(text: string, m: CsvMapping): { header: string[] | null; rows: string[][] } {
  const opts = { relax_column_count: true, skip_empty_lines: true, trim: true, bom: true, ...(m.delimiter ? { delimiter: m.delimiter } : {}) };
  let body = text.replace(/^﻿/, "");
  if (m.skipLines) body = body.split(/\r?\n/).slice(m.skipLines).join("\n");
  const rows = parse(body, opts) as string[][];
  if (m.hasHeader === false) return { header: null, rows };
  return { header: rows[0] ?? [], rows: rows.slice(1) };
}

function resolveCol(header: string[] | null, ref: ColumnRef | undefined, label: string): number {
  if (ref === undefined) return -1;
  if (typeof ref === "number") return ref;
  if (!header) throw new ConnectorError("invalid_input", `CSV has no header; map ${label} by index`, { provider: "csv" });
  const i = header.findIndex((h) => h.trim().toLowerCase() === ref.trim().toLowerCase());
  if (i < 0) throw new ConnectorError("invalid_input", `CSV column not found for ${label}: "${ref}"`, { provider: "csv" });
  return i;
}

/** Suggest a mapping from header names (for the mapping UI preview). */
export function suggestCsvMapping(header: string[]): Partial<CsvMapping> {
  const find = (re: RegExp) => header.find((h) => re.test(h.trim()));
  const out: Partial<CsvMapping> = {};
  const date = find(/^(transaction |posted |trans\.? )?date$/i) ?? find(/date/i);
  if (date) out.date = date;
  const amount = find(/^amount$/i) ?? find(/amount/i);
  const outflow = find(/^(outflow|debit|withdrawal)s?$/i);
  const inflow = find(/^(inflow|credit|deposit)s?$/i);
  if (outflow && inflow) {
    out.outflow = outflow;
    out.inflow = inflow;
  } else if (amount) out.amount = amount;
  const payee = find(/^(payee|merchant|name)$/i);
  const desc = find(/description|details|narrative/i);
  if (payee) out.payee = payee;
  if (desc) out.description = desc;
  const memo = find(/^(memo|notes?)$/i);
  if (memo) out.memo = memo;
  return out;
}

export function previewCsv(text: string, m: Partial<CsvMapping> = {}): { header: string[] | null; sample: string[][]; suggested: Partial<CsvMapping>; detectedDateFormat: DateFormat | null } {
  const { header, rows } = readRows(text, { date: 0, ...m });
  const suggested = header ? suggestCsvMapping(header) : {};
  const mapping = { ...suggested, ...m };
  let detected: DateFormat | null = null;
  try {
    const di = resolveCol(header, mapping.date, "date");
    if (di >= 0) detected = detectDateFormat(rows.slice(0, 50).map((r) => r[di] ?? ""));
  } catch {
    /* preview is best-effort */
  }
  return { header, sample: rows.slice(0, 10), suggested, detectedDateFormat: detected };
}

export interface CsvParseResult {
  transactions: ExternalTxn[];
  dateFormat: DateFormat;
  warnings: string[];
}

/** Parse a CSV into transactions for `accountId` using `mapping`. */
export function parseGenericCsv(text: string, accountId: string, mapping: CsvMapping): CsvParseResult {
  if (mapping.amount === undefined && mapping.outflow === undefined && mapping.inflow === undefined) {
    throw new ConnectorError("invalid_input", "CSV mapping needs amount, or outflow/inflow", { provider: "csv" });
  }
  const { header, rows } = readRows(text, mapping);
  const c = {
    date: resolveCol(header, mapping.date, "date"),
    amount: resolveCol(header, mapping.amount, "amount"),
    outflow: resolveCol(header, mapping.outflow, "outflow"),
    inflow: resolveCol(header, mapping.inflow, "inflow"),
    payee: resolveCol(header, mapping.payee, "payee"),
    memo: resolveCol(header, mapping.memo, "memo"),
    description: resolveCol(header, mapping.description, "description"),
    externalId: resolveCol(header, mapping.externalId, "externalId"),
  };
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  const fmt = mapping.dateFormat && mapping.dateFormat !== "auto" ? mapping.dateFormat : detectDateFormat(rows.map((r) => get(r, c.date)));
  if (!fmt) throw new ConnectorError("parse", "Could not detect the CSV date format; choose one explicitly", { provider: "csv" });

  const warnings: string[] = [];
  const out: ExternalTxn[] = [];
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    const line = i + 1 + (header ? 1 : 0) + (mapping.skipLines ?? 0);
    if (r.every((x) => x.trim() === "")) return;
    const date = parseDateWithFormat(get(r, c.date), fmt);
    if (!date) {
      warnings.push(`line ${line}: unparseable date "${get(r, c.date)}"`);
      return;
    }
    let amount: Milli | undefined;
    try {
      if (c.amount >= 0) {
        amount = parseAmountLoose(get(r, c.amount));
        if (amount !== undefined && mapping.invertAmount) amount = -amount;
      } else {
        const o = parseAmountLoose(get(r, c.outflow));
        const inn = parseAmountLoose(get(r, c.inflow));
        if (o !== undefined || inn !== undefined) amount = (inn ?? 0n) - (o !== undefined ? (o < 0n ? -o : o) : 0n);
      }
    } catch (e) {
      warnings.push(`line ${line}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (amount === undefined) {
      warnings.push(`line ${line}: no amount`);
      return;
    }
    const payee = blankToUndef(get(r, c.payee));
    const description = blankToUndef(get(r, c.description)) ?? payee ?? "";
    const memo = blankToUndef(get(r, c.memo));
    const hash = importHash(accountId, date, amount, description);
    const n = (seen.get(hash) ?? 0) + 1;
    seen.set(hash, n);
    const ext = blankToUndef(get(r, c.externalId)) ?? `csv:${hash.slice(0, 32)}${n > 1 ? `#${n}` : ""}`;
    const t: ExternalTxn = { externalId: ext, accountExternalId: accountId, date, postedAt: null, amount, description, pending: false, raw: header ? Object.fromEntries(header.map((h, j) => [h, r[j] ?? ""])) : r };
    if (payee) t.payee = payee;
    if (memo) t.memo = memo;
    out.push(t);
  });
  return { transactions: out, dateFormat: fmt, warnings };
}

/** §8.4 CSV dedupe: split parsed rows into new / exact duplicates (by import hash) / near duplicates. */
export function dedupeAgainst(
  incoming: ExternalTxn[],
  existing: Array<{ date: ISODate; amount: Milli; description: string; importHash?: string }>,
  accountId: string,
  o: { nearDays?: number } = {},
): { fresh: ExternalTxn[]; exact: ExternalTxn[]; near: ExternalTxn[] } {
  const nearDays = o.nearDays ?? 3;
  const hashes = new Set(existing.map((e) => e.importHash ?? importHash(accountId, e.date, e.amount, e.description)));
  const fresh: ExternalTxn[] = [];
  const exact: ExternalTxn[] = [];
  const near: ExternalTxn[] = [];
  const dayNum = (d: ISODate) => Date.parse(`${d}T12:00:00Z`) / 86_400_000;
  for (const t of incoming) {
    const h = importHash(accountId, t.date, t.amount, t.description);
    if (hashes.has(h)) exact.push(t);
    else if (existing.some((e) => e.amount === t.amount && Math.abs(dayNum(e.date) - dayNum(t.date)) <= nearDays && sharesToken(e.description, t.description))) near.push(t);
    else fresh.push(t);
  }
  return { fresh, exact, near };
}

function sharesToken(a: string, b: string): boolean {
  const ta = new Set(normalizeDescription(a).split(" ").filter((x) => x.length >= 3));
  return normalizeDescription(b)
    .split(" ")
    .some((x) => x.length >= 3 && ta.has(x));
}

