/**
 * Daily balance history per account (the account page chart, the sidebar sparkline).
 *
 * Source of truth, in order: `balances` snapshot rows (what the bank / connector reported that day),
 * then the ledger. Between snapshots the balance is walked from the next later snapshot backwards
 * through the transactions; after the last snapshot it is walked forwards. With no snapshots at all
 * (manual and YNAB-imported accounts) the latest known balance is the working balance, so walking back
 * through the ledger is the running sum of the ledger. Pending rows and deleted rows never count.
 */
import { sql } from "drizzle-orm";
import { addDays, today as localToday, type ISODate, type Milli } from "@homebase/shared";
import type { DbLike } from "../context";

export interface BalancePoint {
  date: ISODate;
  balanceMilli: Milli;
}

export interface HistoryOptions {
  /** First day (default: the account's first transaction or snapshot). */
  from?: ISODate;
  /** Last day (default: today). */
  to?: ISODate;
  /** "Today" for the default `to` (tests pin it). */
  today?: ISODate;
}

const toDay = (v: unknown): ISODate => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/**
 * Pure core of the walk: daily balances over [from, to] from per-day ledger nets and snapshots.
 * `nets` and `snapshots` may be in any order; days outside [from, to] still shape the walk.
 */
export function buildDailyBalances(nets: ReadonlyMap<ISODate, Milli>, snapshots: ReadonlyMap<ISODate, Milli>, from: ISODate, to: ISODate): BalancePoint[] {
  if (from > to) return [];
  const netDays = [...nets.keys()].sort();
  const snapDays = [...snapshots.keys()].sort();
  // cumulative ledger through a day: C(d) = Σ nets ≤ d
  const cumBefore = (() => {
    let acc = 0n;
    const cum = new Map<ISODate, Milli>();
    for (const d of netDays) {
      acc += nets.get(d)!;
      cum.set(d, acc);
    }
    return cum;
  })();
  // C(d) for an arbitrary day via a forward scan, computed incrementally below.
  const out: BalancePoint[] = [];
  let ni = 0;
  let c = 0n; // C(day)
  while (ni < netDays.length && netDays[ni]! < from) c = cumBefore.get(netDays[ni++]!)!;
  let si = 0; // index of the first snapshot ≥ day
  const cAt = (d: ISODate): Milli => {
    // C(d) for a snapshot day (binary search over netDays)
    let lo = 0;
    let hi = netDays.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (netDays[mid]! <= d) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best < 0 ? 0n : cumBefore.get(netDays[best]!)!;
  };
  const snapC = snapDays.map(cAt);
  for (let day = from; day <= to; day = addDays(day, 1)) {
    while (ni < netDays.length && netDays[ni]! <= day) c = cumBefore.get(netDays[ni++]!)!;
    while (si < snapDays.length && snapDays[si]! < day) si++;
    let bal: Milli;
    if (si < snapDays.length && snapDays[si] === day) bal = snapshots.get(day)!;
    else if (si < snapDays.length) bal = snapshots.get(snapDays[si]!)! - (snapC[si]! - c); // walk back from the next snapshot
    else if (snapDays.length) bal = snapshots.get(snapDays[snapDays.length - 1]!)! + (c - snapC[snapDays.length - 1]!); // forward from the last
    else bal = c; // ledger only
    out.push({ date: day, balanceMilli: bal });
  }
  return out;
}

async function loadInputs(db: DbLike, accountIds: string[]) {
  const nets = await db.execute<{ account_id: string; date: string | Date; net: bigint }>(sql`
    SELECT account_id, date, sum(amount_milli)::bigint AS net FROM transactions
    WHERE account_id IN ${accountIds} AND deleted_at IS NULL AND cleared <> 'pending' GROUP BY account_id, date`);
  const snaps = await db.execute<{ account_id: string; as_of: string | Date; current_milli: bigint }>(sql`
    SELECT account_id, as_of, current_milli FROM balances WHERE account_id IN ${accountIds}`);
  const byAcct = new Map<string, { nets: Map<ISODate, Milli>; snaps: Map<ISODate, Milli>; first: ISODate | null }>();
  const get = (id: string) => {
    let v = byAcct.get(id);
    if (!v) byAcct.set(id, (v = { nets: new Map(), snaps: new Map(), first: null }));
    return v;
  };
  for (const id of accountIds) get(id);
  for (const r of nets.rows) {
    const v = get(r.account_id);
    const d = toDay(r.date);
    v.nets.set(d, BigInt(r.net));
    if (!v.first || d < v.first) v.first = d;
  }
  for (const r of snaps.rows) {
    const v = get(r.account_id);
    const d = toDay(r.as_of);
    v.snaps.set(d, BigInt(r.current_milli));
    if (!v.first || d < v.first) v.first = d;
  }
  return byAcct;
}

/** Daily balance for one account, oldest first. Empty when the account has no history at all. */
export async function accountBalanceHistory(db: DbLike, accountId: string, opts: HistoryOptions = {}): Promise<BalancePoint[]> {
  const inputs = (await loadInputs(db, [accountId])).get(accountId)!;
  const to = opts.to ?? opts.today ?? localToday();
  const from = opts.from ?? inputs.first;
  if (!from) return [];
  return buildDailyBalances(inputs.nets, inputs.snaps, from, to);
}

/**
 * Σ daily balance over the open on-budget accounts (cash + credit): the sidebar sparkline and the
 * "all accounts" chart. Accounts that start later contribute their walked-back value (0 for a ledger).
 */
export async function budgetAccountsBalanceHistory(db: DbLike, opts: HistoryOptions = {}): Promise<BalancePoint[]> {
  const res = await db.execute<{ id: string }>(sql`SELECT id FROM accounts WHERE deleted_at IS NULL AND on_budget AND NOT closed`);
  const ids = res.rows.map((r) => r.id);
  if (!ids.length) return [];
  const inputs = await loadInputs(db, ids);
  const firsts = [...inputs.values()].map((v) => v.first).filter((d): d is ISODate => !!d).sort();
  const to = opts.to ?? opts.today ?? localToday();
  const from = opts.from ?? firsts[0];
  if (!from) return [];
  const total = new Map<ISODate, Milli>();
  for (const v of inputs.values()) for (const p of buildDailyBalances(v.nets, v.snaps, from, to)) total.set(p.date, (total.get(p.date) ?? 0n) + p.balanceMilli);
  return [...total.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, balanceMilli]) => ({ date, balanceMilli }));
}
