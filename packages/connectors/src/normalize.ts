/** Shared normalization helpers: import hashes, decimal/amount parsing, timezone-aware epoch math. */
import { createHash } from "node:crypto";
import { TZ, dollarsToMilli, parseMilli, toLocalDate, type ISODate, type Milli } from "@homebase/shared";
import { ConnectorError } from "./types";

/** Uppercase, NFKC, strip punctuation, collapse whitespace. Used for import hashes and fuzzy matching. */
export function normalizeDescription(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^\p{L}\p{N}&]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** §8.2: import_hash = sha256(account_id | date | amount | normalized description), hex. */
export function importHash(accountId: string, date: ISODate, amount: Milli, description: string): string {
  return sha256Hex(`${accountId}|${date}|${amount.toString()}|${normalizeDescription(description)}`);
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Parse provider money into milliunits. Strings are parsed exactly; numbers (JSON APIs that send floats
 * like Mercury) go through dollarsToMilli. Accepts "(12.34)" accounting negatives, "+", "$", ",", "USD".
 */
export function toMilli(v: string | number | null | undefined): Milli {
  if (v === null || v === undefined) throw new ConnectorError("parse", "Missing money amount");
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new ConnectorError("parse", `Invalid money amount: ${v}`);
    return dollarsToMilli(v);
  }
  let s = v.trim().replace(/\b(USD|US\$)\b/gi, "").replace(/[$,\s]/g, "");
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("+")) s = s.slice(1);
  if (/^-?\d*\.?\d+[eE][+-]?\d+$/.test(s)) return (neg ? -1n : 1n) * dollarsToMilli(Number(s));
  const m = parseMilli(s);
  return neg ? -m : m;
}

/** Like toMilli but returns undefined for blank / "--" / "n/a". */
export function toMilliOpt(v: string | number | null | undefined): Milli | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string" && /^\s*(|--|-|n\/a|null)\s*$/i.test(v)) return undefined;
  return toMilli(v);
}

/** Canonical decimal string for quantities (shares, BTC). Never round-trips through floats for strings. */
export function normalizeDecimal(v: string | number): string {
  let s = typeof v === "number" ? numberToPlainString(v) : v.trim().replace(/[,\s$]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  if (/^-?\d*\.?\d+[eE][+-]?\d+$/.test(s)) s = numberToPlainString(Number(s));
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new ConnectorError("parse", `Invalid decimal: ${v}`);
  const int = (m[2] || "0").replace(/^0+(?=\d)/, "");
  const frac = (m[3] ?? "").replace(/0+$/, "");
  const body = frac ? `${int}.${frac}` : int;
  return m[1] && body !== "0" ? `-${body}` : body;
}

function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new ConnectorError("parse", `Invalid number: ${n}`);
  // toFixed(12) avoids exponent notation; trailing zeros are stripped by normalizeDecimal.
  return Math.abs(n) < 1e21 ? n.toFixed(12) : BigInt(Math.round(n)).toString();
}

/** Decimal string → bigint scaled by 10^scale (e.g. BTC → sats with scale 8). Rounds half away from zero. */
export function decimalToScaled(v: string, scale: number): bigint {
  const s = normalizeDecimal(v);
  const neg = s.startsWith("-");
  const [i, f = ""] = (neg ? s.slice(1) : s).split(".");
  const padded = f.padEnd(scale + 1, "0");
  let q = BigInt(i! + padded.slice(0, scale));
  if (Number(padded[scale]) >= 5) q += 1n;
  return neg ? -q : q;
}

/** bigint scaled by 10^scale → canonical decimal string. */
export function scaledToDecimal(v: bigint, scale: number): string {
  const neg = v < 0n;
  const a = (neg ? -v : v).toString().padStart(scale + 1, "0");
  const s = scale === 0 ? a : `${a.slice(0, -scale)}.${a.slice(-scale)}`;
  return normalizeDecimal(neg ? `-${s}` : s);
}

/** Multiply a money amount by a decimal quantity, rounding to milliunits. */
export function mulMilliByDecimal(m: Milli, qty: string): Milli {
  const s = normalizeDecimal(qty);
  const scale = (s.split(".")[1] ?? "").length;
  const q = decimalToScaled(s, scale);
  const den = 10n ** BigInt(scale);
  const p = m * q;
  const neg = p < 0n;
  const a = neg ? -p : p;
  const r = (a * 2n + den) / (den * 2n);
  return neg ? -r : r;
}

/** Offset (ms) of America/New_York from UTC at `instantMs` (negative: EST = -5h). */
const offsetFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
export function tzOffsetMs(instantMs: number): number {
  const parts = offsetFmt.formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** Epoch seconds of 00:00 America/New_York on `date`. */
export function localMidnightEpoch(date: ISODate): number {
  const utcMid = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(utcMid)) throw new ConnectorError("invalid_input", `Invalid date: ${date}`);
  let guess = utcMid - tzOffsetMs(utcMid);
  guess = utcMid - tzOffsetMs(guess);
  return Math.floor(guess / 1000);
}

/** Epoch seconds → ISO instant. */
export function epochToIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

/** Any instant (ISO string w/ offset, epoch seconds) → local budget date. */
export function instantToLocalDate(v: string | number): ISODate {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return toLocalDate(v);
}

export function blankToUndef(s: string | null | undefined): string | undefined {
  if (s === null || s === undefined) return undefined;
  const t = s.trim();
  return t === "" ? undefined : t;
}
