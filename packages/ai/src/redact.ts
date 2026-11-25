/**
 * LLM redaction (spec §4.6, §9.3 privacy).
 *
 * - Runs of 4+ digits in descriptions, memos, payee and account names become "••••".
 *   Amounts are never redacted because they travel as structured fields, not inside text.
 * - Web-search queries may contain only a merchant string and a city: no amounts, digit runs,
 *   emails, phone numbers, household names or account vocabulary.
 */

export const MASK = "••••";

const DIGIT_RUN = /\d{4,}/g;

/** Mask every run of 4 or more digits. */
export function redactDigits(text: string): string {
  return text.replace(DIGIT_RUN, MASK);
}

/** Keys whose string values are free text that may embed card, account or reference numbers. */
export const REDACT_KEY_PATTERN =
  /^(raw_?description|rawDescription|description|memo|raw|payee|payee_?name|payeeName|account|account_?name|accountName|account_?label|accountLabel|note|statement_?descriptor)$/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_OR_TS = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
/** Anything with 8+ consecutive digits looks like an account/card number wherever it appears. */
const LONG_DIGITS = /\d{8,}/g;

/**
 * Deep-redact a JSON-like value before it goes to the model. Free-text keys get the 4-digit rule;
 * every other string still gets an 8-digit safety net (UUIDs and ISO dates are left alone).
 * BigInts are passed through untouched (serialize them separately).
 */
export function redactDeep<T>(value: T, keyPattern: RegExp = REDACT_KEY_PATTERN): T {
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === "string") {
      if (key !== null && keyPattern.test(key)) return redactDigits(v);
      if (UUID.test(v) || ISO_DATE_OR_TS.test(v)) return v;
      return v.replace(LONG_DIGITS, MASK);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, k);
      return out;
    }
    return v;
  };
  return walk(value, null) as T;
}

export interface WebQueryPolicy {
  /** Household member names / surnames that must never appear in a query. */
  householdNames?: string[];
  maxLength?: number;
}

export type WebQueryCheck = { ok: true } | { ok: false; reason: string };

const DENY_WORDS =
  /\b(account|acct|balance|routing|ssn|social security|password|card ending|ending in|last four|statement|transaction amount|paid|charged|salary|income|net worth)\b/i;

/**
 * Regex guard for web_search queries (§9.3): only a merchant string and city are allowed.
 * Used before we would ever forward a query and, for server-side searches, to audit the
 * queries the model actually ran (violations discard the result and raise an event).
 */
export function checkWebSearchQuery(query: string, policy: WebQueryPolicy = {}): WebQueryCheck {
  const q = query.trim();
  if (q === "") return { ok: false, reason: "empty query" };
  if (q.length > (policy.maxLength ?? 120)) return { ok: false, reason: "query too long" };
  if (/[$€£]/.test(q)) return { ok: false, reason: "currency symbol" };
  if (/\d+[.,]\d{2}\b/.test(q)) return { ok: false, reason: "looks like an amount" };
  if (/\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/.test(q)) return { ok: false, reason: "phone number" };
  if (/\d{4,}/.test(q)) return { ok: false, reason: "digit run of 4+" };
  if (/[•]/.test(q)) return { ok: false, reason: "contains redaction mask" };
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(q)) return { ok: false, reason: "email address" };
  if (DENY_WORDS.test(q)) return { ok: false, reason: "financial or personal vocabulary" };
  for (const name of policy.householdNames ?? []) {
    const n = name.trim();
    if (n.length >= 2 && new RegExp(`\\b${escapeRegExp(n)}\\b`, "i").test(q)) {
      return { ok: false, reason: "household member name" };
    }
  }
  return { ok: true };
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
