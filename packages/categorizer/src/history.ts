/**
 * §9.1 step 3: history. If a normalized payee has ≥3 past transactions and ≥90% used one
 * category, use it (confidence 0.90–0.98 scaled by count). If one category doesn't dominate but
 * amount bands do (Costco < $60 = Gas, ≥ $60 = Groceries), learn the band.
 */
import { absMilli, type Milli } from "@homebase/shared";
import type { HistoryTxn, Suggestion } from "./types";

export const HISTORY_MIN_COUNT = 3;
export const HISTORY_MIN_SHARE = 0.9;

export interface AmountBand {
  /** |amount| < thresholdMilli → below; otherwise atOrAbove. */
  thresholdMilli: Milli;
  below: { categoryId: string; count: number; share: number };
  atOrAbove: { categoryId: string; count: number; share: number };
}

export interface HistoryDecision {
  categoryId: string;
  confidence: number;
  count: number;
  share: number;
  band: { thresholdMilli: Milli; side: "below" | "at_or_above" } | null;
  explanation: string;
}

/** 0.90 at 3 transactions, +0.01 per extra one, capped at 0.98; reduced by impurity, floor 0.90. */
export function historyConfidence(count: number, share: number): number {
  if (count < HISTORY_MIN_COUNT) return 0;
  const byCount = Math.min(0.98, 0.9 + 0.01 * (count - HISTORY_MIN_COUNT));
  const c = byCount - (1 - share) * 0.2;
  return Math.round(Math.max(0.9, c) * 1000) / 1000;
}

function usable(h: readonly HistoryTxn[]): HistoryTxn[] {
  return h.filter((t) => t.categoryId !== null && !t.isSplit && !t.isTransfer);
}

function mode(ts: readonly HistoryTxn[]): { categoryId: string; count: number; share: number } | null {
  if (ts.length === 0) return null;
  const counts = new Map<string, number>();
  for (const t of ts) counts.set(t.categoryId!, (counts.get(t.categoryId!) ?? 0) + 1);
  let best: [string, number] | null = null;
  for (const e of counts) if (!best || e[1] > best[1]) best = e;
  return { categoryId: best![0], count: best![1], share: best![1] / ts.length };
}

function niceThreshold(lo: Milli, hi: Milli): Milli {
  const mid = (lo + hi) / 2n;
  const dollars = ((mid + 500n) / 1000n) * 1000n;
  return dollars > lo && dollars <= hi ? dollars : hi;
}

/** Find a two-band amount split where each side is ≥90% one (different) category with ≥3 txns. */
export function learnAmountBands(history: readonly HistoryTxn[]): AmountBand | null {
  const ts = usable(history).slice().sort((a, b) => (absMilli(a.amountMilli) < absMilli(b.amountMilli) ? -1 : absMilli(a.amountMilli) > absMilli(b.amountMilli) ? 1 : 0));
  const n = ts.length;
  if (n < HISTORY_MIN_COUNT * 2) return null;
  let best: { score: number; gap: Milli; band: AmountBand } | null = null;
  for (let k = HISTORY_MIN_COUNT; k <= n - HISTORY_MIN_COUNT; k++) {
    const lo = absMilli(ts[k - 1]!.amountMilli);
    const hi = absMilli(ts[k]!.amountMilli);
    if (lo === hi) continue;
    const left = mode(ts.slice(0, k))!;
    const right = mode(ts.slice(k))!;
    if (left.categoryId === right.categoryId || left.share < HISTORY_MIN_SHARE || right.share < HISTORY_MIN_SHARE) continue;
    if (left.count < HISTORY_MIN_COUNT || right.count < HISTORY_MIN_COUNT) continue;
    const score = (left.count + right.count) / n;
    const gap = hi - lo;
    if (!best || score > best.score || (score === best.score && gap > best.gap)) {
      best = { score, gap, band: { thresholdMilli: niceThreshold(lo, hi), below: left, atOrAbove: right } };
    }
  }
  return best?.band ?? null;
}

/** History decision for a new transaction amount, or null if history isn't decisive. */
export function historyCategory(history: readonly HistoryTxn[], amountMilli: Milli): HistoryDecision | null {
  const ts = usable(history);
  if (ts.length < HISTORY_MIN_COUNT) return null;
  const top = mode(ts)!;
  if (top.share >= HISTORY_MIN_SHARE) {
    return {
      categoryId: top.categoryId,
      confidence: historyConfidence(ts.length, top.share),
      count: ts.length,
      share: top.share,
      band: null,
      explanation: `${top.count} of ${ts.length} past transactions used this category`,
    };
  }
  const band = learnAmountBands(ts);
  if (!band) return null;
  const below = absMilli(amountMilli) < band.thresholdMilli;
  const side = below ? band.below : band.atOrAbove;
  const dollars = `$${(band.thresholdMilli / 1000n).toString()}`;
  return {
    categoryId: side.categoryId,
    confidence: historyConfidence(side.count, side.share),
    count: side.count,
    share: side.share,
    band: { thresholdMilli: band.thresholdMilli, side: below ? "below" : "at_or_above" },
    explanation: `${side.count} past transactions ${below ? "under" : "of at least"} ${dollars} used this category`,
  };
}

/** Category frequencies as suggestions (used for the review queue's top-3). */
export function historySuggestions(history: readonly HistoryTxn[], k = 3): Suggestion[] {
  const ts = usable(history);
  if (ts.length === 0) return [];
  const counts = new Map<string, number>();
  for (const t of ts) counts.set(t.categoryId!, (counts.get(t.categoryId!) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([categoryId, c]) => ({ categoryId, confidence: Math.round((c / ts.length) * 0.85 * 1000) / 1000, source: "history" as const }));
}
