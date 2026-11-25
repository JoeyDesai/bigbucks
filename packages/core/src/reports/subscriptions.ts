/**
 * §13 report 11 / §11.6: subscriptions and recurring bills from the categorizer's `detectRecurring`
 * (per payee, ±3 days, stable amount). Detection uses the full history up to the period's end, so a
 * yearly charge is still found in a one-month view; price changes and new subscriptions are reported
 * relative to the period's start.
 */
import { sql } from "drizzle-orm";
import { detectRecurring, newSubscriptionsSince, priceIncreasesSince, type RecurringCadence, type RecurringSeries, type RecurringTxn } from "@homebase/categorizer";
import { absMilli, addDays, type ISODate, type Milli } from "@homebase/shared";
import type { DbLike } from "../context";
import { resolvePeriod, type ReportParams, type ResolvedPeriod } from "./params";
import { reportScope } from "./scope";
import type { ReportTable } from "./table";

export interface SubscriptionRow {
  key: string;
  payeeId: string;
  payee: string;
  category: string | null;
  categoryId: string | null;
  cadence: RecurringCadence;
  /** Latest charge (positive magnitude). */
  amount: Milli;
  annualized: Milli;
  monthly: Milli;
  occurrences: number;
  firstDate: ISODate;
  lastDate: ISODate;
  nextExpectedDate: ISODate;
  /** Still charging: the next expected date isn't more than a grace period behind the period end. */
  active: boolean;
  priceChange: { from: Milli; to: Milli; changedOn: ISODate; changeBps: number } | null;
  /** First detected inside the period. */
  isNew: boolean;
}

export interface SubscriptionsReport {
  period: ResolvedPeriod;
  params: ReportParams;
  rows: SubscriptionRow[];
  active: SubscriptionRow[];
  totals: { annualized: Milli; monthly: Milli; count: number };
  priceIncreases: SubscriptionRow[];
  newSubscriptions: SubscriptionRow[];
  table: ReportTable;
}

const PER_YEAR: Record<RecurringCadence, bigint> = { weekly: 52n, monthly: 12n, yearly: 1n };
const GRACE: Record<RecurringCadence, number> = { weekly: 7, monthly: 10, yearly: 30 };

export async function subscriptionsReport(db: DbLike, params: ReportParams): Promise<SubscriptionsReport> {
  const period = resolvePeriod(params);
  // history from the beginning, same entity/account rules as spending
  const s = await reportScope(db, params, { from: "1900-01-01", to: period.to });
  const res = await db.execute<{ id: string; date: string; amount: bigint; payee_id: string; payee: string; category_id: string | null; category: string | null }>(sql`
    SELECT coalesce(v.split_id, v.transaction_id)::text AS id, v.date::text AS date, v.amount_milli AS amount, v.payee_id::text AS payee_id,
      v.payee_name AS payee, v.category_id::text AS category_id, v.category_name AS category
    FROM v_transactions_flat v
    WHERE ${s.spend} AND v.amount_milli < 0 AND v.payee_id IS NOT NULL
    ORDER BY v.date`);
  const catName = new Map<string, string>();
  const txns: RecurringTxn[] = res.rows.map((r) => {
    if (r.category_id && r.category) catName.set(r.category_id, r.category);
    return { id: r.id, date: r.date, amountMilli: BigInt(r.amount), payeeKey: r.payee_id, payeeName: r.payee, categoryId: r.category_id };
  });
  const series = detectRecurring(txns).filter((x) => x.isSubscription);
  const increased = new Set(priceIncreasesSince(series, period.from));
  const fresh = new Set(newSubscriptionsSince(series, period.from));
  const toRow = (x: RecurringSeries): SubscriptionRow => {
    const amount = absMilli(x.latestAmountMilli);
    const annualized = amount * PER_YEAR[x.cadence];
    return {
      key: `${x.payeeKey}:${x.cadence}:${x.firstDate}`,
      payeeId: x.payeeKey,
      payee: x.payeeName,
      categoryId: x.categoryId,
      category: x.categoryId ? (catName.get(x.categoryId) ?? null) : null,
      cadence: x.cadence,
      amount,
      annualized,
      monthly: (annualized + 6n) / 12n,
      occurrences: x.occurrences,
      firstDate: x.firstDate,
      lastDate: x.lastDate,
      nextExpectedDate: x.nextExpectedDate,
      active: addDays(x.nextExpectedDate, GRACE[x.cadence]) >= period.to,
      priceChange: x.priceChange ? { from: absMilli(x.priceChange.fromMilli), to: absMilli(x.priceChange.toMilli), changedOn: x.priceChange.changedOn, changeBps: x.priceChange.changeBps } : null,
      isNew: fresh.has(x),
    };
  };
  const rows = series.map(toRow).sort((a, b) => Number(b.active) - Number(a.active) || (b.annualized > a.annualized ? 1 : b.annualized < a.annualized ? -1 : a.payee.localeCompare(b.payee)));
  const active = rows.filter((r) => r.active);
  const annualized = active.reduce((t, r) => t + r.annualized, 0n);
  const keyOf = (x: RecurringSeries) => `${x.payeeKey}:${x.cadence}:${x.firstDate}`;
  const incKeys = new Set([...increased].map(keyOf));
  return {
    period,
    params,
    rows,
    active,
    totals: { annualized, monthly: (annualized + 6n) / 12n, count: active.length },
    priceIncreases: rows.filter((r) => incKeys.has(r.key)),
    newSubscriptions: rows.filter((r) => r.isNew),
    table: {
      columns: [
        { key: "payee", label: "Subscription", kind: "text" },
        { key: "cadence", label: "Every", kind: "text", secondary: true },
        { key: "amount", label: "Charge", kind: "money", secondary: true },
        { key: "next", label: "Next", kind: "date", secondary: true },
        { key: "change", label: "Price change", kind: "bps", secondary: true },
        { key: "status", label: "Status", kind: "text", csvOnly: true },
        { key: "annualized", label: "Per year", kind: "money" },
      ],
      rows: rows.map((r) => ({
        key: r.key,
        drill: { payeeIds: [r.payeeId], from: r.firstDate, to: period.to },
        cells: {
          payee: r.payee,
          cadence: r.cadence === "weekly" ? "week" : r.cadence === "monthly" ? "month" : "year",
          amount: r.amount,
          next: r.active ? r.nextExpectedDate : null,
          change: r.priceChange ? r.priceChange.changeBps : null,
          status: r.active ? "active" : "stopped",
          annualized: r.annualized,
        },
      })),
      total: { payee: "Active total", cadence: null, amount: null, next: null, change: null, status: null, annualized },
    },
  };
}
