import "server-only";
import { sql } from "drizzle-orm";
import { balancesAt, getSetting, holdings, householdEntityId, investmentGrowth, listAccounts, manualHoldings, sampleDates, unitsToDecimal, type AssetClass, type QuoteProvider } from "@homebase/core";
import { addDays, addMonths, lastDayOfMonth, monthOf, type ISODate, type Milli } from "@homebase/shared";
import { getDb } from "../db";
import { cleanLabel } from "@/lib/format";
import { displayBalance } from "./transactions";
import { loadAccountInbox } from "./inbox";

export const INVEST_PERIODS = ["1M", "3M", "YTD", "1Y", "ALL"] as const;
export type InvestPeriod = (typeof INVEST_PERIODS)[number];

const INVEST_KINDS = new Set(["brokerage", "retirement", "hsa", "crypto"]);
const KEEP_UPPER = new Set(["US", "USA", "IRA", "HSA", "TOD", "RSU", "SIP", "S.I.P.", "LLC", "INC", "BTC", "ETH", "XRP", "USDC", "USD", "SEP", "ESPP", "UTMA", "UGMA", "JTWROS", "II", "III"]);

/** Bank-style names read better: drop a trailing provider id "(0000abcd-…)" and soften ALL CAPS. */
export function prettyAccountName(name: string): string {
  let s = name.replace(/\s*\((?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\s*$/i, "").trim();
  const letters = s.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 6 && letters === letters.toUpperCase()) {
    s = s
      .split(" ")
      .map((w) => {
        const bare = w.replace(/[(),]/g, "");
        if (KEEP_UPPER.has(bare) || /\d/.test(bare)) return w.replace(/\(K\)/, "(k)").replace(/\(B\)/, "(b)");
        return w.charAt(0) + w.slice(1).toLowerCase();
      })
      .join(" ")
      .replace(/\b(Of|And|The|For)\b/g, (m) => m.toLowerCase())
      .replace(/^./, (c) => c.toUpperCase());
  }
  return s || name;
}
const KIND_LABEL: Record<string, string> = { brokerage: "Brokerage", retirement: "Retirement", hsa: "HSA", crypto: "Crypto" };

export interface InvestAccountVM {
  id: string;
  name: string;
  institution: string | null;
  kind: string;
  kindLabel: string;
  source: string;
  /** Fixed color slot (0–6) by account order, so a color follows the account, never its rank. */
  slot: number;
  value: Milli;
  /** Value at the start of the period (null when the account is newer than the period). */
  start: Milli | null;
  updatedAt: string | null;
  /** Waiting in the new-accounts inbox (arrived from a sync, not reviewed yet). */
  isNew: boolean;
  /** Hand-entered investment: what it is and how much is held ("0.0523"). */
  manual: { provider: QuoteProvider; symbol: string; units: string } | null;
  /** Hidden from the tab by hand. */
  hidden: boolean;
  /** Worth $0 with nothing in it (closed plans, empty wallets): tucked away with the hidden ones. */
  empty: boolean;
}

export interface FundSeries {
  /** Value on each of `dates` (0 when not held). */
  values: Milli[];
  /** Price per share/coin on each date, milli (null when not held). */
  prices: (Milli | null)[];
}

export interface InvestHoldingVM {
  symbol: string;
  name: string | null;
  quantity: string;
  value: Milli;
  gain: Milli | null;
  costBasis: Milli | null;
  weightBps: number;
  assetClass: AssetClass;
  accounts: string[];
}

export interface InvestmentsPage {
  period: InvestPeriod;
  today: ISODate;
  /** Selected account, or null for all of them. */
  accountId: string | null;
  accounts: InvestAccountVM[];
  dates: ISODate[];
  /** Per account id, its value on each of `dates` (0 before the account existed). */
  series: Record<string, Milli[]>;
  /** Per account id, the index in `dates` of its first balance (-1 = none in this range). */
  firstKnown: Record<string, number>;
  growth: { month: string; contributions: Milli; market: Milli; known: boolean; partial: boolean }[];
  growthTotals: { change: Milli; contributions: Milli; marketChange: Milli };
  holdings: { asOf: ISODate | null; total: Milli; positions: InvestHoldingVM[]; allocation: { assetClass: AssetClass; value: Milli; weightBps: number }[] };
  /** Per symbol, over `dates`, across the shown account(s). */
  funds: Record<string, FundSeries>;
}

/**
 * Each symbol's value and price on each date: for every account, the latest holdings snapshot on or
 * before that date (so a fund that was sold drops out instead of being carried forward).
 */
async function fundSeries(ids: string[], dates: ISODate[]): Promise<Record<string, FundSeries>> {
  if (!ids.length || !dates.length) return {};
  const res = await getDb().execute<{ date: string; symbol: string; v: string; p: string | null }>(sql`
    SELECT d.date::text AS date, h.symbol, sum(h.market_value_milli)::text AS v,
      round(sum(h.market_value_milli) / nullif(sum(h.quantity), 0))::bigint::text AS p
    FROM unnest(string_to_array(${dates.join(",")}, ',')::date[]) AS d(date)
    CROSS JOIN unnest(string_to_array(${ids.join(",")}, ',')::uuid[]) AS acc(id)
    JOIN LATERAL (SELECT max(as_of) AS m FROM holdings WHERE account_id = acc.id AND as_of <= d.date) l ON l.m IS NOT NULL
    JOIN holdings h ON h.account_id = acc.id AND h.as_of = l.m
    GROUP BY 1, 2`);
  const idx = new Map(dates.map((d, i) => [d, i]));
  const out: Record<string, FundSeries> = {};
  for (const r of res.rows) {
    const i = idx.get(r.date);
    if (i === undefined) continue;
    const f = (out[r.symbol] ??= { values: dates.map(() => 0n), prices: dates.map(() => null) });
    f.values[i] = BigInt(r.v);
    f.prices[i] = r.p === null ? null : BigInt(r.p);
  }
  return out;
}

function periodStart(p: InvestPeriod, today: ISODate, earliest: ISODate | null): ISODate {
  if (p === "1M") return addDays(today, -30);
  if (p === "3M") return addDays(today, -91);
  if (p === "YTD") return addDays(`${today.slice(0, 4)}-01-01`, -1);
  // same window as the 12-month growth split, so "past year" = put in + market exactly
  if (p === "1Y") return lastDayOfMonth(addMonths(monthOf(today), -12));
  return earliest && earliest < today ? earliest : addDays(today, -365);
}

/** Investments tab: every household brokerage / retirement / HSA / crypto account, or one of them. */
export async function loadInvestments(period: InvestPeriod, accountParam: string | null, today: ISODate): Promise<InvestmentsPage> {
  const db = getDb();
  const household = await householdEntityId(db);
  const all = (await listAccounts(db, { today })).filter((a) => INVEST_KINDS.has(a.kind) && (household === null || a.entityId === household));
  all.sort((a, b) => a.sort - b.sort || a.displayName.localeCompare(b.displayName));
  const ids = all.map((a) => a.id);
  const accountId = accountParam && ids.includes(accountParam) ? accountParam : null;
  const hiddenIds = new Set((await getSetting(db, "investments_hidden")).account_ids);

  const manual = new Map((await manualHoldings(db)).map((m) => [m.id, { provider: m.provider, symbol: m.symbol, units: unitsToDecimal(m.units) }]));
  const withHoldings = ids.length ? new Set((await db.execute<{ id: string }>(sql`SELECT DISTINCT account_id::text AS id FROM v_holdings_latest WHERE account_id IN ${ids} AND market_value_milli <> 0`)).rows.map((r) => r.id)) : new Set<string>();
  const inbox = ids.length ? new Set((await loadAccountInbox()).map((e) => e.accountId)) : new Set<string>();
  const first = ids.length
    ? (await db.execute<{ d: string | null }>(sql`SELECT min(as_of)::text AS d FROM balances WHERE account_id IN ${ids}`)).rows[0]?.d ?? null
    : null;
  const from = periodStart(period, today, first);
  const span = Math.round((Date.parse(today) - Date.parse(from)) / 86_400_000);
  const dates = sampleDates(from, today, span <= 100 ? "day" : span <= 800 ? "week" : "month");
  const bal = ids.length ? await balancesAt(db, dates, { includeBusiness: true, accountIds: ids }) : [];
  const at = new Map(bal.map((b) => [`${b.accountId}|${b.date}`, b.balance]));
  const series: Record<string, Milli[]> = {};
  const firstKnown: Record<string, number> = {};
  for (const id of ids) {
    series[id] = dates.map((d) => at.get(`${id}|${d}`) ?? 0n);
    firstKnown[id] = dates.findIndex((d) => at.has(`${id}|${d}`));
  }

  const accounts: InvestAccountVM[] = all.map((a, i) => {
    const updated = a.lastSyncAt ? a.lastSyncAt.toISOString() : a.syncedAsOf ? `${a.syncedAsOf}T12:00:00Z` : null;
    return {
      id: a.id,
      name: a.nickname ? cleanLabel(a.nickname) : prettyAccountName(cleanLabel(a.name)),
      institution: a.institution,
      kind: a.kind,
      kindLabel: KIND_LABEL[a.kind] ?? a.kind,
      source: a.source,
      slot: i % 7,
      value: displayBalance(a),
      start: firstKnown[a.id]! >= 0 ? at.get(`${a.id}|${dates[firstKnown[a.id]!]}`)! : null,
      updatedAt: updated,
      isNew: inbox.has(a.id),
      manual: manual.get(a.id) ?? null,
      hidden: hiddenIds.has(a.id),
      empty: displayBalance(a) === 0n && !withHoldings.has(a.id),
    };
  });

  // "All accounts" means the ones on show: hidden and empty accounts stay out of the totals too
  const shownIds = accounts.filter((a) => !a.hidden && !a.empty).map((a) => a.id);
  const growth = await investmentGrowth(db, accountId ?? shownIds, 12, { today });
  const h = await holdings(db, accountId ? { accountId } : { accountIds: shownIds });
  const funds = await fundSeries(accountId ? [accountId] : shownIds, dates);
  const nameOf = new Map(accounts.map((a) => [a.id, a.name]));
  return {
    period,
    today,
    accountId,
    accounts,
    dates,
    series,
    firstKnown,
    growth: growth.months.map((m) => ({ month: m.month, contributions: m.contributions, market: m.marketChange, known: m.contributionsKnown, partial: m.partial })),
    growthTotals: growth.totals,
    holdings: {
      asOf: h.asOf,
      total: h.total,
      positions: h.positions.map((p) => ({
        symbol: p.symbol,
        name: p.name,
        quantity: p.quantity,
        value: p.marketValue,
        gain: p.gain,
        costBasis: p.costBasis,
        weightBps: p.weightBps,
        assetClass: p.assetClass,
        accounts: p.accounts.map((x) => nameOf.get(x.accountId) ?? cleanLabel(x.accountName)),
      })),
      allocation: h.allocation.map((x) => ({ assetClass: x.assetClass, value: x.marketValue, weightBps: x.weightBps })),
    },
    funds,
  };
}
