/**
 * §11.6 recurring / subscription detection and price-change detection.
 *
 * Per payee and direction, amounts are first clustered (so two Apple subscriptions at different
 * prices are separate series), then each cluster is checked for a regular interval —
 * weekly, monthly or yearly, ±3 days — and amount stability.
 */
import { absMilli, addDays, addMonths, daysBetween, daysInMonth, type ISODate, type Milli } from "@homebase/shared";

export type RecurringCadence = "weekly" | "monthly" | "yearly";

export interface RecurringTxn {
  id: string;
  date: ISODate;
  amountMilli: Milli;
  payeeKey: string;
  payeeName: string;
  categoryId?: string | null;
}

export interface PriceChange {
  fromMilli: Milli;
  toMilli: Milli;
  changedOn: ISODate;
  /** to − from (signed, in the series' direction: positive = more money). */
  changeMilli: Milli;
  /** Relative change in basis points of |from|. */
  changeBps: number;
}

export interface RecurringSeries {
  payeeKey: string;
  payeeName: string;
  cadence: RecurringCadence;
  direction: "outflow" | "inflow";
  occurrences: number;
  firstDate: ISODate;
  /** Date of the occurrence that first made the pattern detectable. */
  detectedOn: ISODate;
  lastDate: ISODate;
  nextExpectedDate: ISODate;
  medianIntervalDays: number;
  /** Most recent amount (signed). */
  latestAmountMilli: Milli;
  /** Amount is the same (±1%) most of the time. */
  stableAmount: boolean;
  /** Stable-amount outflow: a subscription/bill for the Subscriptions view. */
  isSubscription: boolean;
  categoryId: string | null;
  transactionIds: string[];
  priceChange: PriceChange | null;
}

export interface RecurringOptions {
  toleranceDays?: number;
  /** Fraction of intervals that must match the cadence (default 0.75). */
  minIntervalMatch?: number;
}

const MIN_OCCURRENCES: Record<RecurringCadence, number> = { weekly: 4, monthly: 3, yearly: 2 };

function intervalMatches(c: RecurringCadence, days: number, tol: number): boolean {
  switch (c) {
    case "weekly":
      return Math.abs(days - 7) <= tol;
    case "monthly":
      return days >= 28 - tol && days <= 31 + tol;
    case "yearly":
      return days >= 365 - tol && days <= 366 + tol;
  }
}

function nextDate(c: RecurringCadence, last: ISODate, anchorDay: number): ISODate {
  if (c === "weekly") return addDays(last, 7);
  const m = addMonths(`${last.slice(0, 7)}-01`, c === "monthly" ? 1 : 12);
  const day = Math.min(anchorDay, daysInMonth(m));
  return `${m.slice(0, 8)}${String(day).padStart(2, "0")}`;
}

/** Same amount within 1% (or 1 cent). */
function sameAmount(a: Milli, b: Milli): boolean {
  const x = absMilli(a);
  const y = absMilli(b);
  const diff = x > y ? x - y : y - x;
  return diff <= 10n || diff * 100n <= (x > y ? x : y);
}

/** Single-linkage clusters on |amount|: a new cluster starts where the next amount is >1.5× the previous one. */
function clusterByAmount(ts: RecurringTxn[]): RecurringTxn[][] {
  const sorted = ts.slice().sort((a, b) => (absMilli(a.amountMilli) < absMilli(b.amountMilli) ? -1 : 1));
  const clusters: RecurringTxn[][] = [];
  let cur: RecurringTxn[] = [];
  let prev = 0n;
  for (const t of sorted) {
    const a = absMilli(t.amountMilli);
    if (cur.length && a * 2n > prev * 3n) {
      clusters.push(cur);
      cur = [];
    }
    cur.push(t);
    prev = a;
  }
  if (cur.length) clusters.push(cur);
  return clusters.map((c) => c.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)));
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

function priceChangeOf(ts: RecurringTxn[]): { stable: boolean; change: PriceChange | null } {
  if (ts.length < 2) return { stable: true, change: null };
  let same = 0;
  for (let i = 1; i < ts.length; i++) if (sameAmount(ts[i - 1]!.amountMilli, ts[i]!.amountMilli)) same++;
  const stable = same / (ts.length - 1) >= 0.6;
  // Latest plateau vs. the plateau before it.
  let i = ts.length - 1;
  while (i > 0 && sameAmount(ts[i - 1]!.amountMilli, ts[i]!.amountMilli)) i--;
  if (i === 0) return { stable, change: null };
  const prevEnd = i - 1;
  let j = prevEnd;
  while (j > 0 && sameAmount(ts[j - 1]!.amountMilli, ts[j]!.amountMilli)) j--;
  const prevPlateauLen = prevEnd - j + 1;
  if (!stable || prevPlateauLen < 2) return { stable, change: null };
  const from = ts[prevEnd]!.amountMilli;
  const to = ts[ts.length - 1]!.amountMilli;
  const changeMilli = absMilli(to) - absMilli(from);
  return {
    stable,
    change: { fromMilli: from, toMilli: to, changedOn: ts[i]!.date, changeMilli, changeBps: Number((changeMilli * 10_000n) / absMilli(from)) },
  };
}

function modeCategory(ts: RecurringTxn[]): string | null {
  const c = new Map<string, number>();
  for (const t of ts) if (t.categoryId) c.set(t.categoryId, (c.get(t.categoryId) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [k, v] of c) if (v > n) (best = k), (n = v);
  return best;
}

export function detectRecurring(txns: readonly RecurringTxn[], opts: RecurringOptions = {}): RecurringSeries[] {
  const tol = opts.toleranceDays ?? 3;
  const need = opts.minIntervalMatch ?? 0.75;
  const groups = new Map<string, RecurringTxn[]>();
  for (const t of txns) {
    if (t.amountMilli === 0n || !t.payeeKey) continue;
    const k = `${t.payeeKey}|${t.amountMilli < 0n ? "o" : "i"}`;
    const g = groups.get(k) ?? [];
    g.push(t);
    groups.set(k, g);
  }
  const out: RecurringSeries[] = [];
  for (const [k, g] of groups) {
    const direction = k.endsWith("|o") ? "outflow" : "inflow";
    for (const cluster of clusterByAmount(g)) {
      if (cluster.length < 2) continue;
      const intervals: number[] = [];
      for (let i = 1; i < cluster.length; i++) intervals.push(daysBetween(cluster[i - 1]!.date, cluster[i]!.date));
      let cadence: RecurringCadence | null = null;
      for (const c of ["weekly", "monthly", "yearly"] as const) {
        if (cluster.length < MIN_OCCURRENCES[c]) continue;
        const hits = intervals.filter((d) => intervalMatches(c, d, tol)).length;
        if (hits / intervals.length >= need && intervalMatches(c, intervals[intervals.length - 1]!, tol)) {
          cadence = c;
          break;
        }
      }
      if (!cadence) continue;
      const { stable, change } = priceChangeOf(cluster);
      const first = cluster[0]!;
      const last = cluster[cluster.length - 1]!;
      out.push({
        payeeKey: first.payeeKey,
        payeeName: last.payeeName,
        cadence,
        direction,
        occurrences: cluster.length,
        firstDate: first.date,
        detectedOn: cluster[Math.min(cluster.length, MIN_OCCURRENCES[cadence]) - 1]!.date,
        lastDate: last.date,
        nextExpectedDate: nextDate(cadence, last.date, Number(last.date.slice(8, 10))),
        medianIntervalDays: median(intervals),
        latestAmountMilli: last.amountMilli,
        stableAmount: stable,
        isSubscription: direction === "outflow" && stable,
        categoryId: modeCategory(cluster),
        transactionIds: cluster.map((t) => t.id),
        priceChange: change,
      });
    }
  }
  return out.sort((a, b) => (a.payeeName < b.payeeName ? -1 : a.payeeName > b.payeeName ? 1 : 0));
}

/** Series whose price changed on or after `since` (for "Which subscriptions went up in price?"). */
export function priceIncreasesSince(series: readonly RecurringSeries[], since: ISODate): RecurringSeries[] {
  return series.filter((s) => s.priceChange && s.priceChange.changeMilli > 0n && s.priceChange.changedOn >= since);
}

/** Subscriptions first detected on or after `since` (weekly digest "new subscriptions"). */
export function newSubscriptionsSince(series: readonly RecurringSeries[], since: ISODate): RecurringSeries[] {
  return series.filter((s) => s.isSubscription && s.detectedOn >= since);
}
