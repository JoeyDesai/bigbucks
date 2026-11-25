/**
 * §9.2 deterministic payee normalization: strip POS/ACH prefixes, processor tags (SQ *, TST*,
 * PAYPAL *), store numbers, trailing city/state, card suffixes and reference numbers, then
 * title-case. Plus alias matching (exact / prefix / regex) for payee_aliases.
 */
import type { PayeeAlias } from "./types";

export interface NormalizedPayee {
  /** Clean display name, e.g. "Lowe's". */
  name: string;
  /** Stable matching key, e.g. "lowes". */
  key: string;
  /** Location parsed from the descriptor, used as a web-lookup hint. */
  city: string | null;
  state: string | null;
}

export const US_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN",
  "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA",
  "WA", "WV", "WI", "WY", "DC",
]);

const CITY_PREFIXES = new Set(["NEW", "SAN", "LOS", "LAS", "ST", "SAINT", "FORT", "FT", "EL", "PALM", "GLEN", "WEST", "EAST", "NORTH", "SOUTH", "MT", "MOUNT", "VIRGINIA", "SALT", "CHRISTIANS"]);

const PREFIXES: RegExp[] = [
  /^(PURCHASE|RECURRING PAYMENT|MONEY TRANSFER|PAYMENT) AUTHORIZED ON \d{1,2}\/\d{1,2}\s*/,
  /^(POS PURCHASE|POS DEBIT|POS WITHDRAWAL|POS)\s+/,
  /^(DEBIT CARD PURCHASE|DEBIT PURCHASE|DBT CRD|MOBILE PURCHASE|VISA PURCHASE|CHECK CARD|CHECKCARD)(\s+\d{4})?\s+/,
  /^(PURCHASE RETURN|PURCHASE|RETURN)\s+/,
  /^(ACH DEBIT|ACH CREDIT|ACH PMT|ACH PAYMENT|ACH WITHDRAWAL|ACH DEPOSIT|ACH)\s+/,
  /^(ONLINE PAYMENT|PREAUTHORIZED DEBIT|ELECTRONIC PAYMENT|EXTERNAL WITHDRAWAL|EXTERNAL DEPOSIT|BILL PAY|BILLPAY)\s+/,
  /^(SQ|TST|PAYPAL|PP|SP|IN|PY|BT|DD|GG|EB|WPY|ZTL|SMK|CKO|PAR|LS|AMS|FS)\s?\*\s*/,
  /^WWW\./,
];

const KNOWN_MERCHANTS: [RegExp, string][] = [
  [/^(AMZN|AMAZON)\b/, "Amazon"],
  [/^(WM SUPERCENTER|WAL-?MART|WALMART)\b/, "Walmart"],
  [/^COSTCO\b/, "Costco"],
  [/^TARGET\b/, "Target"],
  [/^LOWE'?S\b/, "Lowe's"],
  [/^(THE )?HOME DEPOT\b/, "Home Depot"],
  [/^NETFLIX\b/, "Netflix"],
  [/^SPOTIFY\b/, "Spotify"],
  [/^APPLE(\.COM| COM)?\b/, "Apple"],
  [/^GOOGLE\b/, "Google"],
  [/^UBER\s*EATS\b/, "Uber Eats"],
  [/^UBER\b/, "Uber"],
  [/^LYFT\b/, "Lyft"],
  [/^DOORDASH\b/, "DoorDash"],
  [/^STARBUCKS\b/, "Starbucks"],
  [/^MCDONALD'?S\b/, "McDonald's"],
  [/^CHICK-?FIL-?A\b/, "Chick-fil-A"],
  [/^KROGER\b/, "Kroger"],
  [/^FOOD LION\b/, "Food Lion"],
  [/^7-?ELEVEN\b/, "7-Eleven"],
  [/^SHEETZ\b/, "Sheetz"],
  [/^CVS\b/, "CVS"],
  [/^WALGREENS\b/, "Walgreens"],
  [/^CHEWY\b/, "Chewy"],
  [/^VENMO\b/, "Venmo"],
];

const ACRONYMS = new Set(["USA", "US", "ATM", "BP", "CVS", "KFC", "IHOP", "TJ", "LLC", "IRS", "DMV", "USPS", "UPS", "HVAC", "AAA", "TV", "HBO", "AMC", "YMCA", "BBQ", "ACH", "BOA", "PNC", "TD", "USAA", "WF"]);
const SMALL_WORDS = new Set(["of", "and", "the", "a", "an", "at", "by", "for", "in", "on", "to", "or"]);

/** Title-case a cleaned upper-case merchant string ("LOWE'S" → "Lowe's", "AT&T" stays). */
export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      const up = w.toUpperCase();
      if (ACRONYMS.has(up) || /&/.test(w) || (/^[a-z]{2,4}$/.test(w) && !/[aeiouy]/.test(w))) return up;
      if (i > 0 && SMALL_WORDS.has(w)) return w;
      return w
        .split(/([-'.])/)
        .map((part, j, arr) => {
          if (part === "" || /[-'.]/.test(part)) return part;
          // after an apostrophe, short suffixes stay lower: Lowe's, Don't; O'Reilly capitalizes
          if (j > 0 && arr[j - 1] === "'" && part.length <= 2) return part;
          return part[0]!.toUpperCase() + part.slice(1);
        })
        .join("");
    })
    .join(" ");
}

export function normalizedKey(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function stripPrefixes(s: string): string {
  let prev = "";
  while (prev !== s) {
    prev = s;
    for (const re of PREFIXES) s = s.replace(re, "").trim();
  }
  return s;
}

/** Deterministic cleanup of a raw bank descriptor. */
export function normalizePayee(raw: string): NormalizedPayee {
  let s = raw.toUpperCase().replace(/\s+/g, " ").trim();
  s = stripPrefixes(s);

  let city: string | null = null;
  let state: string | null = null;

  // Reference / card / id noise anywhere.
  s = s
    .replace(/\b(WEB|PPD|CCD|CO|TEL|IAT)\s+ID:?\s*\S+/g, " ")
    .replace(/\b(REF|TRACE|TRN|CONF|AUTH|INDN|ORIG CO NAME|CO ENTRY DESCR|SEC)\s*(#|NO\.?|:)\s*\S+/g, " ")
    .replace(/\bCARD\s*\d{4}\b/g, " ")
    .replace(/\b(X{2,}|\*{2,})\d{4}\b/g, " ")
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, " ")
    .replace(/\(?\b\d{3}\)?[-.\s]?\d{3}[-.]?\d{4}\b/g, " ")
    .replace(/\b\d{3}-\d{7}\b/g, " ")
    .replace(/\*[A-Z0-9]{4,}\b/g, " ")
    .replace(/\.(COM|NET|ORG|CO)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // A store number marks the end of the merchant name: "LOWE'S #1234 FAIRVIEW VA" / "KROGER 0423 MILTON VA".
  const store = /\s(#\s*\d+|STORE\s*#?\s*\d+|NO\.?\s*\d+|\d{3,}[A-Z]?)(\s|$)/.exec(s);
  if (store && store.index > 0) {
    const rest = s.slice(store.index + store[0].length).replace(/\b[A-Z]*\d{3,}[A-Z0-9]*\b/g, " ").replace(/\s+/g, " ").trim();
    const loc = /^([A-Z][A-Z .'-]*?)\s+([A-Z]{2})$/.exec(rest);
    if (loc && US_STATES.has(loc[2]!)) {
      city = loc[1]!.trim();
      state = loc[2]!;
    } else if (rest.length === 2 && US_STATES.has(rest)) state = rest;
    s = s.slice(0, store.index);
  }

  // Remaining long digit tokens (reference numbers like S586287012345678).
  s = s.replace(/\b[A-Z]*\d{5,}[A-Z0-9]*\b/g, " ").replace(/\s+/g, " ").trim();

  // Trailing "CITY ST" when no store number told us where the name ends.
  if (!state) {
    const toks = s.split(" ");
    const last = toks[toks.length - 1];
    if (toks.length >= 2 && last && US_STATES.has(last)) {
      toks.pop();
      state = last;
      if (toks.length >= 3) {
        const c = [toks.pop()!];
        if (toks.length >= 3 && CITY_PREFIXES.has(toks[toks.length - 1]!)) c.unshift(toks.pop()!);
        city = c.join(" ");
      }
      s = toks.join(" ");
    }
  }

  // Generic payment words left at the end of ACH descriptors.
  s = s.replace(/(\s+(BILLPAY|BILL PAY|PYMT|PMT|PAYMENT|E-PAYMENT|EPAY|AUTOPAY|AUTO PAY|ONLINE|WEB|PPD|CCD|RECUR|RECURRING|DEBIT|INC|LLC|CORP|CO))+$/, "");
  s = s.replace(/[*#:;,\-./\s]+$/, "").replace(/^[*#:;,\-./\s]+/, "").trim();
  if (!s) s = raw.trim().toUpperCase().slice(0, 40);

  const known = KNOWN_MERCHANTS.find(([re]) => re.test(s));
  const name = known ? known[1] : titleCase(s);
  return {
    name,
    key: normalizedKey(name),
    city: city ? titleCase(city) : null,
    state,
  };
}

function collapse(s: string): string {
  return s.toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * Match a raw descriptor against payee_aliases. Exact beats prefix beats regex; the longest
 * prefix wins; invalid regexes are ignored.
 */
export function matchAlias(raw: string, aliases: readonly PayeeAlias[]): PayeeAlias | null {
  const r = collapse(raw);
  // Prefix aliases also match after POS/ACH/"PURCHASE AUTHORIZED ON 10/14" prefixes are removed.
  const forms = [r, stripPrefixes(r)];
  const exact = aliases.find((a) => a.match === "exact" && forms.includes(collapse(a.pattern)));
  if (exact) return exact;
  let best: PayeeAlias | null = null;
  for (const a of aliases) {
    if (a.match !== "prefix") continue;
    const p = collapse(a.pattern);
    if (p && forms.some((f) => f.startsWith(p)) && (!best || p.length > collapse(best.pattern).length)) best = a;
  }
  if (best) return best;
  for (const a of aliases) {
    if (a.match !== "regex") continue;
    try {
      if (new RegExp(a.pattern, "i").test(raw)) return a;
    } catch {
      /* invalid pattern: skip */
    }
  }
  return null;
}

/** Proposed alias for a descriptor → payee mapping (prefix on the cleaned head of the raw string). */
export function proposeAliasPattern(raw: string): { pattern: string; match: "prefix" | "exact" } {
  const r = collapse(stripPrefixes(collapse(raw)));
  const head = /^(.*?)(\s(#\s*\d+|\d{3,}).*)?$/.exec(r)?.[1]?.trim() ?? r;
  return head.length >= 4 ? { pattern: head, match: "prefix" } : { pattern: collapse(raw), match: "exact" };
}
