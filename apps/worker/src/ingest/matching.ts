/**
 * §8.4 matching rules (pure). The ingest step feeds these with DB candidates.
 *
 *  - Pending → posted: same account, same sign, amount within ±20% (tips, gas holds), ≤ 7 days, similar payee.
 *  - Scheduled → synced: same account, amount exact or within ±$1, ±4 days.
 *  - YNAB-imported → synced (parallel run): same account, exact amount, ±3 days, fuzzy payee.
 *    A candidate with no payee text on either side matches only when it is the sole candidate.
 */
import { normalizeDescription } from "@homebase/connectors";
import { daysBetween, type ISODate, type Milli } from "@homebase/shared";

export const PENDING_AMOUNT_TOLERANCE_PCT = 20n;
export const PENDING_MAX_DAYS = 7;
export const SCHEDULED_AMOUNT_TOLERANCE_MILLI = 1000n;
export const SCHEDULED_MAX_DAYS = 4;
export const YNAB_MAX_DAYS = 3;
export const PAYEE_SIMILARITY_THRESHOLD = 0.35;

/** Tokens that carry no merchant identity. */
const NOISE = new Set([
  "POS", "PURCHASE", "DEBIT", "CREDIT", "CARD", "SQ", "TST", "SP", "PP", "ACH", "PPD", "WEB", "ID", "REF", "THE", "AND", "INC", "LLC", "CO", "COM", "WWW",
  "RECURRING", "PAYMENT", "ONLINE", "CHECKCARD", "VISA", "MC", "AUTH", "PENDING", "TRANSACTION",
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "IA", "IL", "IN", "KS", "KY", "LA", "MA", "MD", "ME", "MI", "MN", "MO", "MS", "MT",
  "NC", "ND", "NE", "NH", "NJ", "NM", "NV", "NY", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VA", "VT", "WA", "WI", "WV", "WY", "DC",
]);

export function payeeTokens(s: string | null | undefined): string[] {
  return normalizeDescription(s)
    .split(" ")
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !NOISE.has(t));
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const x = s.replace(/\s+/g, "");
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** 0..1: 1 when a significant token is shared (or one is a prefix of the other), else Dice bigram similarity. */
export function payeeSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = payeeTokens(a);
  const tb = payeeTokens(b);
  if (!ta.length || !tb.length) return 0;
  for (const x of ta) for (const y of tb) if (x === y || (x.length >= 4 && y.startsWith(x)) || (y.length >= 4 && x.startsWith(y))) return 1;
  const A = bigrams(ta.join(" "));
  const B = bigrams(tb.join(" "));
  let inter = 0;
  let total = 0;
  for (const [g, n] of A) {
    inter += Math.min(n, B.get(g) ?? 0);
    total += n;
  }
  for (const n of B.values()) total += n;
  return total === 0 ? 0 : (2 * inter) / total;
}

/** Best similarity between any text of `a` and any text of `b` (description, payee name …). */
export function bestSimilarity(a: (string | null | undefined)[], b: (string | null | undefined)[]): number {
  let best = 0;
  for (const x of a) for (const y of b) best = Math.max(best, payeeSimilarity(x, y));
  return best;
}

const hasText = (xs: (string | null | undefined)[]) => xs.some((x) => payeeTokens(x).length > 0);
const abs = (x: Milli) => (x < 0n ? -x : x);

/** |a − b| ≤ pct% of |b|, same sign. */
export function withinPct(a: Milli, b: Milli, pct: bigint): boolean {
  if (a === b) return true;
  if ((a < 0n) !== (b < 0n) || a === 0n || b === 0n) return false;
  return abs(a - b) * 100n <= abs(b) * pct;
}

export interface IncomingTxn {
  date: ISODate;
  amount: Milli;
  texts: (string | null | undefined)[];
}

export interface Candidate {
  id: string;
  date: ISODate;
  amount: Milli;
  texts: (string | null | undefined)[];
  /** YNAB transfer rows ("Transfer : Checking") never share words with the bank's descriptor. */
  transfer?: boolean;
}

/** Bank descriptors of card payments and account transfers. */
export const TRANSFERISH = /\b(PAYMENT|PMT|TRANSFER|XFER|AUTO ?PAY|E-?PAYMENT|EPAY|THANK YOU|DEPOSIT FROM|WITHDRAWAL TO|MERCURY)\b/i;

interface Scored<C extends Candidate> {
  c: C;
  days: number;
  amountDiff: Milli;
  sim: number;
}

function pick<C extends Candidate>(scored: Scored<C>[]): C | null {
  if (!scored.length) return null;
  scored.sort((x, y) => y.sim - x.sim || x.days - y.days || (x.amountDiff < y.amountDiff ? -1 : x.amountDiff > y.amountDiff ? 1 : 0) || (x.c.id < y.c.id ? -1 : 1));
  return scored[0]!.c;
}

/** Posted transaction → the pending row it replaces. */
export function matchPendingToPosted<C extends Candidate>(posted: IncomingTxn, pending: readonly C[]): C | null {
  const scored: Scored<C>[] = [];
  for (const c of pending) {
    const days = Math.abs(daysBetween(c.date, posted.date));
    if (days > PENDING_MAX_DAYS) continue;
    if (!withinPct(posted.amount, c.amount, PENDING_AMOUNT_TOLERANCE_PCT)) continue;
    const sim = bestSimilarity(posted.texts, c.texts);
    // Same bank, same descriptor family: require similarity unless both texts are empty and the amount is exact.
    if (sim < PAYEE_SIMILARITY_THRESHOLD && !(posted.amount === c.amount && !hasText(posted.texts) && !hasText(c.texts))) continue;
    scored.push({ c, days, amountDiff: abs(posted.amount - c.amount), sim });
  }
  return pick(scored);
}

/** Synced transaction → a materialized scheduled transaction row. */
export function matchScheduled<C extends Candidate>(txn: IncomingTxn, scheduled: readonly C[]): C | null {
  const scored: Scored<C>[] = [];
  for (const c of scheduled) {
    const days = Math.abs(daysBetween(c.date, txn.date));
    if (days > SCHEDULED_MAX_DAYS) continue;
    if ((txn.amount < 0n) !== (c.amount < 0n)) continue;
    const diff = abs(txn.amount - c.amount);
    if (diff > SCHEDULED_AMOUNT_TOLERANCE_MILLI) continue;
    scored.push({ c, days, amountDiff: diff, sim: diff === 0n ? 1 : 0 });
  }
  return pick(scored);
}

/** Synced transaction ↔ YNAB-imported row (either direction): exact amount, ±3 days, fuzzy payee. */
export function matchYnab<C extends Candidate>(txn: IncomingTxn, candidates: readonly C[]): C | null {
  const pool = candidates.filter((c) => c.amount === txn.amount && Math.abs(daysBetween(c.date, txn.date)) <= YNAB_MAX_DAYS);
  const scored: Scored<C>[] = [];
  for (const c of pool) {
    let sim = bestSimilarity(txn.texts, c.texts);
    if (c.transfer && txn.texts.some((t) => t && TRANSFERISH.test(t))) sim = Math.max(sim, 0.5);
    const textless = !hasText(txn.texts) || !hasText(c.texts);
    if (sim < PAYEE_SIMILARITY_THRESHOLD && !(textless && pool.length === 1)) continue;
    scored.push({ c, days: Math.abs(daysBetween(c.date, txn.date)), amountDiff: 0n, sim });
  }
  return pick(scored);
}
