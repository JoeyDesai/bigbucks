/** Holdings and investment growth (spec §7.5, §12.3 investment detail, §13 report 9, §11.3 `holdings`). */
import { sql } from "drizzle-orm";
import { accounts } from "@homebase/db";
import { addDays, addMonths, lastDayOfMonth, monthOf, today as localToday, type ISODate, type Milli, type Month } from "@homebase/shared";
import { eq, inArray } from "drizzle-orm";
import type { DbLike } from "../context";
import { NotFoundError } from "../errors";
import { balancesAt, householdEntityId } from "./netWorth";

export type AssetClass = "us_stock" | "intl_stock" | "target_date" | "bond" | "cash" | "crypto" | "other";

/** Best-effort asset class from symbol/name (§12.3 "by asset class where it can be inferred"). */
export function assetClassOf(symbol: string, name: string | null): AssetClass {
  const s = symbol.toUpperCase();
  const n = (name ?? "").toLowerCase();
  if (["BTC", "ETH", "SOL", "USDC"].includes(s) || /bitcoin|ethereum/.test(n)) return "crypto";
  if (/money market|cash|core position|spaxx|fdrxx/.test(n) || ["SPAXX", "FDRXX", "VMFXX"].includes(s)) return "cash";
  if (/freedom|target (retirement|date)|target\b/.test(n)) return "target_date";
  if (/bond|treasury|aggregate|income fund/.test(n)) return "bond";
  if (/international|intl|ex[- ]us|emerging|developed/.test(n)) return "intl_stock";
  if (/500|total (stock )?market|s&p|index|growth|value|nasdaq/.test(n)) return "us_stock";
  return "other";
}

export interface Position {
  symbol: string;
  name: string | null;
  /** Decimal string (numeric(28,10) summed in SQL — no floats). */
  quantity: string;
  price: string | null;
  marketValue: Milli;
  costBasis: Milli | null;
  gain: Milli | null;
  /** Share of the total in basis points. */
  weightBps: number;
  assetClass: AssetClass;
  accounts: { accountId: string; accountName: string; marketValue: Milli }[];
}

export interface HoldingsResult {
  asOf: ISODate | null;
  total: Milli;
  positions: Position[];
  allocation: { assetClass: AssetClass; marketValue: Milli; weightBps: number }[];
}

/** Latest snapshot per account, lots summed per symbol; across accounts when no `accountId`. */
export async function holdings(db: DbLike, opts: { accountId?: string; accountIds?: string[]; includeBusiness?: boolean } = {}): Promise<HoldingsResult> {
  const conds = [sql`TRUE`];
  if (opts.accountIds && !opts.accountIds.length) return { asOf: null, total: 0n, positions: [], allocation: [] };
  if (opts.accountId) conds.push(sql`h.account_id = ${opts.accountId}`);
  else if (opts.accountIds) conds.push(sql`h.account_id IN ${opts.accountIds}`);
  else if (!opts.includeBusiness) {
    const hh = await householdEntityId(db);
    if (hh) conds.push(sql`a.entity_id = ${hh}`);
  }
  const res = await db.execute<{ account_id: string; account_name: string; as_of: string; symbol: string; name: string | null; quantity: string; price: string | null; market_value_milli: bigint; cost_basis_milli: bigint | null }>(sql`
    SELECT h.account_id, h.account_name, h.as_of::text AS as_of, h.symbol, h.name, h.quantity::text AS quantity, h.price::text AS price, h.market_value_milli, h.cost_basis_milli
    FROM v_holdings_latest h JOIN accounts a ON a.id = h.account_id
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY h.market_value_milli DESC`);
  const bySym = new Map<string, { name: string | null; qty: string[]; price: string | null; mv: Milli; cost: Milli | null; costKnown: boolean; accts: Position["accounts"] }>();
  let asOf: ISODate | null = null;
  for (const r of res.rows) {
    if (!asOf || r.as_of > asOf) asOf = r.as_of;
    const p = bySym.get(r.symbol) ?? { name: r.name, qty: [], price: r.price, mv: 0n, cost: 0n, costKnown: true, accts: [] };
    p.qty.push(r.quantity);
    p.mv += BigInt(r.market_value_milli);
    // 0 on a position worth something = the provider didn't know it (rows stored before the connector fix)
    if (r.cost_basis_milli === null || (BigInt(r.cost_basis_milli) === 0n && BigInt(r.market_value_milli) !== 0n)) p.costKnown = false;
    else p.cost = (p.cost ?? 0n) + BigInt(r.cost_basis_milli);
    p.accts.push({ accountId: r.account_id, accountName: r.account_name, marketValue: BigInt(r.market_value_milli) });
    bySym.set(r.symbol, p);
  }
  // exact decimal sums of quantities in Postgres
  const syms = [...bySym.keys()];
  const qtySums = new Map<string, string>();
  if (syms.length) {
    const vals = sql.join(
      [...bySym.entries()].flatMap(([sym, p]) => p.qty.map((q) => sql`(${sym}, ${q}::numeric)`)),
      sql`, `,
    );
    const q = await db.execute<{ symbol: string; q: string }>(sql`SELECT symbol, sum(q)::text AS q FROM (VALUES ${vals}) AS v(symbol, q) GROUP BY symbol`);
    for (const r of q.rows) qtySums.set(r.symbol, r.q);
  }
  let total = 0n;
  for (const p of bySym.values()) total += p.mv;
  const bps = (v: Milli) => (total === 0n ? 0 : Number((v * 10_000n) / total));
  const positions: Position[] = [...bySym.entries()]
    .map(([symbol, p]) => {
      const cost = p.costKnown ? p.cost : null;
      return {
        symbol,
        name: p.name,
        quantity: qtySums.get(symbol) ?? p.qty[0] ?? "0",
        price: p.price,
        marketValue: p.mv,
        costBasis: cost,
        gain: cost === null ? null : p.mv - cost,
        weightBps: bps(p.mv),
        assetClass: assetClassOf(symbol, p.name),
        accounts: p.accts,
      };
    })
    .sort((a, b) => (b.marketValue > a.marketValue ? 1 : b.marketValue < a.marketValue ? -1 : a.symbol.localeCompare(b.symbol)));
  const alloc = new Map<AssetClass, Milli>();
  for (const p of positions) alloc.set(p.assetClass, (alloc.get(p.assetClass) ?? 0n) + p.marketValue);
  return {
    asOf,
    total,
    positions,
    allocation: [...alloc.entries()].map(([assetClass, marketValue]) => ({ assetClass, marketValue, weightBps: bps(marketValue) })).sort((a, b) => b.weightBps - a.weightBps),
  };
}

export interface GrowthMonth {
  month: Month;
  start: Milli;
  end: Milli;
  change: Milli;
  /** Known contributions: transfers into the account + the account's manual monthly contribution. */
  contributions: Milli;
  marketChange: Milli;
  /** False when no contribution source is known: marketChange then includes unknown contributions. */
  contributionsKnown: boolean;
  label: "market change" | "market change + unknown contributions";
  partial: boolean;
}

export interface GrowthResult {
  accountId: string | null;
  months: GrowthMonth[];
  totals: { change: Milli; contributions: Milli; marketChange: Milli };
}

/**
 * Monthly growth split into contributions vs market change (§7.5): growth = Δ balance − known
 * contributions. Known = transfers into the account that month, plus `accounts.monthly_contribution_milli`
 * for each completed month. Without either, the remainder is labelled "market change + unknown
 * contributions". `accountId` omitted = every household investment/retirement/crypto account summed.
 */
export async function investmentGrowth(db: DbLike, accountId: string | string[] | null, months = 12, opts: { today?: ISODate } = {}): Promise<GrowthResult> {
  const today = opts.today ?? localToday();
  let accts: { id: string; monthly: Milli | null }[];
  if (Array.isArray(accountId)) {
    accts = accountId.length ? await db.select({ id: accounts.id, monthly: accounts.monthlyContributionMilli }).from(accounts).where(inArray(accounts.id, accountId)) : [];
  } else if (accountId) {
    const [a] = await db.select({ id: accounts.id, monthly: accounts.monthlyContributionMilli }).from(accounts).where(eq(accounts.id, accountId));
    if (!a) throw new NotFoundError("account", accountId);
    accts = [a];
  } else {
    const hh = await householdEntityId(db);
    const rows = await db.execute<{ id: string; monthly: bigint | null }>(
      sql`SELECT id, monthly_contribution_milli AS monthly FROM accounts WHERE deleted_at IS NULL AND kind IN ('brokerage', 'retirement', 'hsa', 'crypto') AND entity_id = ${hh}`,
    );
    accts = rows.rows.map((r) => ({ id: r.id, monthly: r.monthly === null ? null : BigInt(r.monthly) }));
  }
  const ids = accts.map((a) => a.id);
  const cur = monthOf(today);
  const monthList: Month[] = [];
  for (let i = months - 1; i >= 0; i--) monthList.push(addMonths(cur, -i));
  const ends = monthList.map((m) => (m === cur ? today : lastDayOfMonth(m)));
  const starts = monthList.map((m) => addDays(m, -1));
  const bal = ids.length ? await balancesAt(db, [...new Set([...ends, ...starts])], { includeBusiness: true, accountIds: ids }) : [];
  const at = new Map(bal.map((b) => [`${b.accountId}|${b.date}`, b.balance]));
  const inflows = ids.length
    ? await db.execute<{ account_id: string; month: string; amt: bigint }>(sql`
        SELECT account_id::text AS account_id, date_trunc('month', date)::date::text AS month, sum(amount_milli)::bigint AS amt
        FROM transactions
        WHERE deleted_at IS NULL AND account_id IN ${ids} AND amount_milli > 0 AND transfer_account_id IS NOT NULL
          AND date >= ${monthList[0]!} AND date <= ${today}
        GROUP BY 1, 2`)
    : { rows: [] };
  const inflowBy = new Map(inflows.rows.map((r) => [`${r.account_id}|${r.month}`, BigInt(r.amt)]));
  const out: GrowthMonth[] = monthList.map((m, i) => {
    // An account counts in a month only once it has a balance at the month's start: one that first
    // shows up mid-month (newly connected) isn't growth.
    const tracked = accts.filter((a) => at.has(`${a.id}|${starts[i]}`));
    const start = tracked.reduce((s, a) => s + at.get(`${a.id}|${starts[i]}`)!, 0n);
    const end = tracked.reduce((s, a) => s + (at.get(`${a.id}|${ends[i]}`) ?? 0n), 0n);
    const partial = m === cur && today !== lastDayOfMonth(m);
    const transfers = tracked.reduce((s, a) => s + (inflowBy.get(`${a.id}|${m}`) ?? 0n), 0n);
    const manual = partial ? 0n : tracked.reduce((s, a) => s + (a.monthly ?? 0n), 0n);
    const known = transfers !== 0n || tracked.some((a) => a.monthly !== null);
    const contributions = transfers + manual;
    const change = end - start;
    return {
      month: m,
      start,
      end,
      change,
      contributions,
      marketChange: change - contributions,
      contributionsKnown: known,
      label: known ? "market change" : "market change + unknown contributions",
      partial,
    };
  });
  return {
    accountId: Array.isArray(accountId) ? null : accountId,
    months: out,
    totals: {
      change: out.reduce((s, m) => s + m.change, 0n),
      contributions: out.reduce((s, m) => s + m.contributions, 0n),
      marketChange: out.reduce((s, m) => s + m.marketChange, 0n),
    },
  };
}
