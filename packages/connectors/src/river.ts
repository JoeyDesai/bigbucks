/**
 * River (Bitcoin) account-activity CSV importer (§7.4 option 2). River has no public API.
 * Quantities are tracked in satoshis (bigint); USD values in milliunits.
 */
import { parse } from "csv-parse/sync";
import type { ISODate, Milli } from "@homebase/shared";
import { blankToUndef, decimalToScaled, instantToLocalDate, mulMilliByDecimal, scaledToDecimal, sha256Hex, toMilliOpt } from "./normalize";
import { ConnectorError, type ExternalTxn } from "./types";

export const RIVER_ACCOUNT_ID = "river";
export const SATS_PER_BTC = 100_000_000n;

/** Logical fields → accepted header spellings (case/whitespace-insensitive). */
export const RIVER_COLUMNS = {
  date: ["Date (UTC)", "Date", "Date UTC", "Timestamp (UTC)"],
  referenceCode: ["Reference Code", "Reference"],
  type: ["Transaction Type", "Type"],
  sentAmount: ["Sent Amount"],
  sentCurrency: ["Sent Currency"],
  receivedAmount: ["Received Amount"],
  receivedCurrency: ["Received Currency"],
  feeAmount: ["Fee Amount"],
  feeCurrency: ["Fee Currency"],
  totalAmount: ["Total Amount"],
  totalCurrency: ["Total Currency"],
  method: ["Method"],
  source: ["Source"],
  destination: ["Destination"],
  costBasis: ["Cost Basis"],
  costBasisCurrency: ["Cost Basis Currency"],
  btcPriceAmount: ["Bitcoin Price Amount", "Bitcoin Price"],
  btcPriceCurrency: ["Bitcoin Price Currency"],
  transactionId: ["Transaction ID", "Transaction Id", "TxID"],
  recurring: ["Recurring"],
  tag: ["Tag"],
} as const;
export type RiverField = keyof typeof RIVER_COLUMNS;
export type RiverMapping = Partial<Record<RiverField, string>>;
const REQUIRED: RiverField[] = ["date", "type"];

const norm = (s: string) => s.replace(/^﻿/, "").trim().toLowerCase().replace(/\s+/g, " ");

function readCsv(text: string): string[][] {
  return parse(text.replace(/^﻿/, ""), { relax_column_count: true, skip_empty_lines: true, trim: true, bom: true }) as string[][];
}

/** Column-mapping preview: detected headers, suggested mapping, missing required fields, first rows. */
export function previewRiverCsv(text: string, sampleSize = 5): { headers: string[]; mapping: RiverMapping; missing: RiverField[]; sample: Record<string, string>[] } {
  const rows = readCsv(text);
  const headers = rows[0] ?? [];
  const mapping: RiverMapping = {};
  for (const [field, names] of Object.entries(RIVER_COLUMNS) as [RiverField, readonly string[]][]) {
    const hit = headers.find((h) => names.some((n) => norm(n) === norm(h)));
    if (hit !== undefined) mapping[field] = hit;
  }
  const missing = REQUIRED.filter((f) => !mapping[f]);
  const sample = rows.slice(1, 1 + sampleSize).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
  return { headers, mapping, missing, sample };
}

/** "2024-01-15 14:30:00" (UTC), ISO, or "01/15/2024 14:30" → ISO instant (UTC). */
export function parseRiverDate(s: string): string {
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i.exec(t);
  if (m) {
    const [, y, mo, d, h = "0", mi = "0", se = "0", tz] = m;
    const base = Date.UTC(+y!, +mo! - 1, +d!, +h, +mi, +se);
    let off = 0;
    if (tz && /^[+-]/.test(tz)) {
      const sign = tz.startsWith("-") ? -1 : 1;
      const digits = tz.slice(1).replace(":", "");
      off = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
    }
    return new Date(base - off).toISOString();
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (m) {
    const [, mo, d, y, h = "0", mi = "0", se = "0"] = m;
    return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h, +mi, +se)).toISOString();
  }
  const p = Date.parse(t);
  if (Number.isNaN(p)) throw new ConnectorError("parse", `Unrecognized River date: ${s}`, { provider: "river_csv" });
  return new Date(p).toISOString();
}

export interface RiverRow {
  line: number;
  at: string;
  date: ISODate;
  referenceCode?: string;
  type: string;
  sent?: { amount: string; currency: string };
  received?: { amount: string; currency: string };
  fee?: { amount: string; currency: string };
  /** Signed BTC movement for this row, sats (received − sent − BTC fee). */
  btcDeltaSats: bigint;
  /** USD cost basis reported by River, if any. */
  costBasis?: Milli;
  btcPrice?: Milli;
  transactionId?: string;
  tag?: string;
  raw: Record<string, string>;
}

const amt = (a: string | undefined, c: string | undefined) => {
  const am = blankToUndef(a);
  const cu = blankToUndef(c);
  return am && cu ? { amount: am.replace(/[$,\s]/g, ""), currency: cu.toUpperCase() } : undefined;
};

/** Parse rows using `mapping` (from previewRiverCsv, possibly edited by the user). */
export function parseRiverCsv(text: string, mapping?: RiverMapping): { rows: RiverRow[]; warnings: string[] } {
  const all = readCsv(text);
  const headers = all[0] ?? [];
  const map = mapping ?? previewRiverCsv(text).mapping;
  const missing = REQUIRED.filter((f) => !map[f]);
  if (missing.length) throw new ConnectorError("parse", `River CSV is missing columns: ${missing.join(", ")}`, { provider: "river_csv" });
  const idx = (f: RiverField) => (map[f] ? headers.findIndex((h) => norm(h) === norm(map[f]!)) : -1);
  const ix = Object.fromEntries((Object.keys(RIVER_COLUMNS) as RiverField[]).map((f) => [f, idx(f)])) as Record<RiverField, number>;
  const get = (r: string[], f: RiverField) => (ix[f] >= 0 ? (r[ix[f]] ?? "") : "");

  const rows: RiverRow[] = [];
  const warnings: string[] = [];
  all.slice(1).forEach((r, i) => {
    const line = i + 2;
    try {
      if (r.every((c) => c.trim() === "")) return;
      const at = parseRiverDate(get(r, "date"));
      const sent = amt(get(r, "sentAmount"), get(r, "sentCurrency"));
      const received = amt(get(r, "receivedAmount"), get(r, "receivedCurrency"));
      const fee = amt(get(r, "feeAmount"), get(r, "feeCurrency"));
      let delta = 0n;
      if (received?.currency === "BTC") delta += decimalToScaled(received.amount, 8);
      if (sent?.currency === "BTC") delta -= decimalToScaled(sent.amount, 8);
      if (fee?.currency === "BTC") delta -= decimalToScaled(fee.amount, 8);
      const row: RiverRow = { line, at, date: instantToLocalDate(at), type: get(r, "type").trim(), btcDeltaSats: delta, raw: Object.fromEntries(headers.map((h, j) => [h, r[j] ?? ""])) };
      const ref = blankToUndef(get(r, "referenceCode"));
      if (ref) row.referenceCode = ref;
      if (sent) row.sent = sent;
      if (received) row.received = received;
      if (fee) row.fee = fee;
      const cb = toMilliOpt(get(r, "costBasis"));
      if (cb !== undefined) row.costBasis = cb;
      const px = toMilliOpt(get(r, "btcPriceAmount"));
      if (px !== undefined) row.btcPrice = px;
      const txid = blankToUndef(get(r, "transactionId"));
      if (txid) row.transactionId = txid;
      const tag = blankToUndef(get(r, "tag"));
      if (tag) row.tag = tag;
      rows.push(row);
    } catch (e) {
      warnings.push(`line ${line}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return { rows, warnings };
}

export interface BtcPosition {
  sats: bigint;
  btc: string;
  /** Σ USD spent on BTC buys − Σ USD received on sells (net cash in), milliunits. */
  netUsdInvested: Milli;
  /** Σ River-reported cost basis on rows that carry it (milli). */
  reportedCostBasis: Milli;
  asOf: string | null;
}

/** Compute the BTC position from parsed rows, optionally through a date (inclusive, local). */
export function computeBtcPosition(rows: RiverRow[], through?: ISODate): BtcPosition {
  let sats = 0n;
  let usd = 0n;
  let cb = 0n;
  let asOf: string | null = null;
  for (const r of rows) {
    if (through && r.date > through) continue;
    sats += r.btcDeltaSats;
    if (r.sent?.currency === "USD" && r.received?.currency === "BTC") usd += toMilliOpt(r.sent.amount) ?? 0n;
    if (r.received?.currency === "USD" && r.sent?.currency === "BTC") usd -= toMilliOpt(r.received.amount) ?? 0n;
    if (r.costBasis !== undefined) cb += r.costBasis;
    if (!asOf || r.at > asOf) asOf = r.at;
  }
  return { sats, btc: scaledToDecimal(sats, 8), netUsdInvested: usd, reportedCostBasis: cb, asOf };
}

/** Value a sats position at a BTC-USD price (milli per BTC), rounded to milliunits. */
export function valueSats(sats: bigint, priceMilliPerBtc: Milli): Milli {
  const p = sats * priceMilliPerBtc;
  const neg = p < 0n;
  const a = neg ? -p : p;
  const q = (a * 2n + SATS_PER_BTC) / (SATS_PER_BTC * 2n);
  return neg ? -q : q;
}

/**
 * Rows → ExternalTxn on the River tracking account. Amount = USD value of the BTC movement:
 * buys use USD sent, sells use −USD received, otherwise BTC × reported BTC price.
 */
export function riverRowsToTxns(rows: RiverRow[], accountId = RIVER_ACCOUNT_ID): ExternalTxn[] {
  const counts = new Map<string, number>();
  return rows.map((r) => {
    let amount: Milli = 0n;
    if (r.sent?.currency === "USD" && r.btcDeltaSats > 0n) amount = toMilliOpt(r.sent.amount) ?? 0n;
    else if (r.received?.currency === "USD" && r.btcDeltaSats < 0n) amount = -(toMilliOpt(r.received.amount) ?? 0n);
    else if (r.btcPrice !== undefined) amount = mulMilliByDecimal(r.btcPrice, scaledToDecimal(r.btcDeltaSats, 8));
    const baseId = r.referenceCode ?? r.transactionId ?? sha256Hex(`${r.at}|${r.type}|${r.btcDeltaSats}`).slice(0, 24);
    const n = (counts.get(baseId) ?? 0) + 1;
    counts.set(baseId, n);
    const t: ExternalTxn = {
      externalId: n === 1 ? baseId : `${baseId}#${n}`,
      accountExternalId: accountId,
      date: r.date,
      postedAt: r.at,
      amount,
      description: `River ${r.type}`.trim(),
      pending: false,
      asset: { symbol: "BTC", quantity: scaledToDecimal(r.btcDeltaSats, 8) },
      raw: r.raw,
    };
    if (r.tag) t.memo = r.tag;
    return t;
  });
}
