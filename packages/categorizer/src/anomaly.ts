/**
 * §11.6 unusual transactions: more than 3σ above that payee's (or, without enough payee history,
 * that category's) norm. Statistics run on cents as JS numbers — this is descriptive math for a
 * flag, never money arithmetic; reported amounts stay bigint milliunits.
 */
import { absMilli, type ISODate, type Milli } from "@homebase/shared";

export interface AnomalyTxn {
  id: string;
  date: ISODate;
  amountMilli: Milli;
  payeeKey: string | null;
  categoryId: string | null;
}

export interface Anomaly {
  transactionId: string;
  basis: "payee" | "category";
  amountMilli: Milli;
  /** Typical (mean) amount, signed like the transaction. */
  meanMilli: Milli;
  stdMilli: Milli;
  zScore: number;
}

export interface AnomalyOptions {
  sigma?: number;
  /** Minimum past samples for a basis to be used (default 5). */
  minSamples?: number;
  /** Ignore small transactions (default $25). */
  minAbsMilli?: Milli;
}

function stats(xs: number[]): { mean: number; std: number } {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return { mean, std: Math.sqrt(variance) };
}

const cents = (m: Milli) => Number(absMilli(m) / 10n);
const toMilli = (c: number, sign: bigint) => sign * BigInt(Math.round(c)) * 10n;

/**
 * Flag transactions in `window` against `history` (same direction only; the window transactions
 * themselves are excluded from their own baseline).
 */
export function detectAnomalies(window: readonly AnomalyTxn[], history: readonly AnomalyTxn[], opts: AnomalyOptions = {}): Anomaly[] {
  const sigma = opts.sigma ?? 3;
  const minSamples = opts.minSamples ?? 5;
  const minAbs = opts.minAbsMilli ?? 25_000n;
  const windowIds = new Set(window.map((t) => t.id));
  const byPayee = new Map<string, number[]>();
  const byCategory = new Map<string, number[]>();
  for (const h of history) {
    if (windowIds.has(h.id) || h.amountMilli === 0n) continue;
    const dir = h.amountMilli < 0n ? "o" : "i";
    if (h.payeeKey) {
      const k = `${h.payeeKey}|${dir}`;
      (byPayee.get(k) ?? byPayee.set(k, []).get(k)!).push(cents(h.amountMilli));
    }
    if (h.categoryId) {
      const k = `${h.categoryId}|${dir}`;
      (byCategory.get(k) ?? byCategory.set(k, []).get(k)!).push(cents(h.amountMilli));
    }
  }
  const out: Anomaly[] = [];
  for (const t of window) {
    if (absMilli(t.amountMilli) < minAbs) continue;
    const dir = t.amountMilli < 0n ? "o" : "i";
    const sign = t.amountMilli < 0n ? -1n : 1n;
    const p = t.payeeKey ? byPayee.get(`${t.payeeKey}|${dir}`) : undefined;
    const c = t.categoryId ? byCategory.get(`${t.categoryId}|${dir}`) : undefined;
    const [basis, xs] = p && p.length >= minSamples ? (["payee", p] as const) : c && c.length >= minSamples ? (["category", c] as const) : [null, null];
    if (!basis || !xs) continue;
    const { mean, std } = stats(xs);
    const v = cents(t.amountMilli);
    const flagged = std > 0 ? v > mean + sigma * std : v > mean * 2 && v - mean >= 1000; // identical history: >2x and ≥ $10 more
    if (!flagged) continue;
    out.push({
      transactionId: t.id,
      basis,
      amountMilli: t.amountMilli,
      meanMilli: toMilli(mean, sign),
      stdMilli: BigInt(Math.round(std)) * 10n,
      zScore: std > 0 ? Math.round(((v - mean) / std) * 100) / 100 : Infinity,
    });
  }
  return out.sort((a, b) => b.zScore - a.zScore);
}
