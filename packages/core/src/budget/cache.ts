/**
 * Engine cache (spec §5.1 budget_month_cache / budget_month_summary, §6 "recompute from the earliest
 * month that changed").
 *
 *  - `recompute` runs the pure engine over the full history (carry and RTA depend on all of it) and
 *    rewrites cache rows only from `fromMonth` on, for the current ENGINE_VERSION.
 *  - Freshness: a fingerprint of the engine's input tables (row count + max(updated_at) per table) is
 *    stored with the cache in `settings[engine_cache_state]`. Writes made through core recompute inside
 *    their own transaction; writes from elsewhere (sync worker, imports) change the fingerprint, and the
 *    next read recomputes in full (or they call `invalidateBudget(db, month)` / `recompute` themselves).
 *  - The last BudgetResult is memoized per fingerprint, so the Plan screen can show engine detail that the
 *    cache schema doesn't hold (status labels, spending split, target progress) without re-running it.
 */
import { and, eq, gt, gte, ne, sql } from "drizzle-orm";
import { budgetMonthCache, budgetMonthSummary, settings } from "@homebase/db";
import { ENGINE_VERSION, computeBudget, type BudgetResult, type BudgetSnapshot, type Month } from "@homebase/engine";
import { addMonths, monthOf, type ISODate } from "@homebase/shared";
import { inOrder, lockBudget, type DbLike } from "../context";
import { lastAssignedMonth, loadSnapshot } from "./snapshot";

export const CACHE_STATE_KEY = "engine_cache_state";

export interface CacheState {
  engineVersion: number;
  fingerprint: string;
  asOf: ISODate;
  through: Month;
  firstMonth: Month | null;
  /** Set by invalidateBudget(); the next recompute starts here. */
  dirtyFrom: Month | null;
  computedAt: string;
}

const FINGERPRINT_TABLES = [
  "accounts",
  "category_groups",
  "categories",
  "transactions",
  "transaction_splits",
  "month_assignments",
  "targets",
  "scheduled_transactions",
  "scheduled_transaction_splits",
  "payroll_runs",
] as const;

/** One round trip: database name + per-table count/max(updated_at). */
export async function budgetFingerprint(db: DbLike): Promise<string> {
  const parts = FINGERPRINT_TABLES.map((t) => `(SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') FROM ${t})`);
  const res = await db.execute(sql.raw(`SELECT concat_ws('|', current_database(), ${parts.join(", ")}) AS fp`));
  return String((res.rows[0] as { fp: string }).fp);
}

export async function readCacheState(db: DbLike): Promise<CacheState | null> {
  const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, CACHE_STATE_KEY));
  const v = rows[0]?.value as CacheState | undefined;
  return v && typeof v === "object" && "fingerprint" in v ? v : null;
}

async function writeCacheState(db: DbLike, state: CacheState): Promise<void> {
  await db
    .insert(settings)
    .values({ key: CACHE_STATE_KEY, value: state })
    .onConflictDoUpdate({ target: settings.key, set: { value: state, updatedAt: new Date() } });
}

/** Mark the cache stale from `month` (for writers outside core that know what they changed). */
export async function invalidateBudget(db: DbLike, month: Month): Promise<void> {
  const st = await readCacheState(db);
  if (!st) return;
  const dirtyFrom = st.dirtyFrom && st.dirtyFrom < month ? st.dirtyFrom : month;
  await writeCacheState(db, { ...st, dirtyFrom, fingerprint: "" });
}

// ── memo ────────────────────────────────────────────────────────────────────

interface Memo {
  key: string;
  result: BudgetResult;
}
let memo: Memo | null = null;

const memoKey = (fp: string, asOf: ISODate, through: Month) => `${ENGINE_VERSION}|${asOf}|${through}|${fp}`;

export function clearBudgetMemo(): void {
  memo = null;
}

// ── recompute ───────────────────────────────────────────────────────────────

export interface RecomputeOptions {
  /** First month whose cache rows are rewritten (default: all). */
  fromMonth?: Month | null;
  /** "Today" (America/New_York). */
  today: ISODate;
  /**
   * Read path: after taking the lock, re-check freshness and do nothing if another caller already
   * recomputed; the rewrite range is derived from the cache state (ignores `fromMonth`).
   */
  onlyIfStale?: boolean;
}

export interface RecomputeResult {
  result: BudgetResult;
  snapshot: BudgetSnapshot;
  through: Month;
  /** First month whose category rows were rewritten (null = none; summary rows are always rewritten). */
  writtenFrom: Month | null;
  monthsWritten: number;
  rowsWritten: number;
  /** onlyIfStale and the cache was already fresh once the lock was held: nothing was written. */
  skipped?: boolean;
}

/** The cache matches the data, the engine version and "today". */
export function isCacheFresh(state: CacheState | null, fingerprint: string, today: ISODate): state is CacheState {
  return !!state && state.engineVersion === ENGINE_VERSION && state.fingerprint === fingerprint && !state.dirtyFrom && state.asOf === today && state.through >= monthOf(today);
}

/** For a stale cache: the first month to rewrite (undefined = everything). */
function staleFrom(state: CacheState | null, fingerprint: string, today: ISODate): Month | undefined {
  if (!state || state.engineVersion !== ENGINE_VERSION) return undefined;
  if (state.fingerprint === fingerprint && !state.dirtyFrom) {
    // only "today" moved: upcoming amounts and Age of Money change from the old today's month on
    const a = monthOf(state.asOf);
    const b = monthOf(today);
    return a < b ? a : b;
  }
  if (state.dirtyFrom) return state.dirtyFrom;
  return undefined;
}

/** through = max(current month, last month with an assignment). */
export function throughMonth(snapshot: BudgetSnapshot, today: ISODate): Month {
  const cur = monthOf(today);
  const last = lastAssignedMonth(snapshot);
  return last && last > cur ? last : cur;
}

export function runEngine(snapshot: BudgetSnapshot, today: ISODate, through?: Month): BudgetResult {
  return computeBudget(snapshot, { through: through ?? throughMonth(snapshot, today), asOf: today });
}

/**
 * Run the engine and upsert cache rows from `fromMonth` (default: the first month) for the current
 * ENGINE_VERSION. Older engine versions' rows are dropped. Runs in its own READ COMMITTED transaction
 * (savepoint if `db` is already one) whose first statement takes the cache advisory lock, so concurrent
 * recomputes queue and every statement after the lock sees what the previous holder committed.
 */
export async function recompute(db: DbLike, opts: RecomputeOptions): Promise<RecomputeResult> {
  const runner = db as unknown as { transaction<T>(fn: (tx: DbLike) => Promise<T>): Promise<T> };
  return runner.transaction<RecomputeResult>(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('homebase.budget_cache'))`);
    const prev = await readCacheState(tx);
    // Fingerprint the inputs *before* reading them: if another writer commits mid-load, the stored
    // fingerprint is older than the data and the next read recomputes again (never the reverse).
    const fingerprint = await budgetFingerprint(tx);
    let fromMonth = opts.fromMonth;
    if (opts.onlyIfStale) {
      if (isCacheFresh(prev, fingerprint, opts.today)) {
        // someone else recomputed while we waited for the lock
        const key = memoKey(fingerprint, opts.today, prev.through);
        const snapshot = await loadSnapshot(tx);
        const result = memo && memo.key === key ? memo.result : runEngine(snapshot, opts.today, prev.through);
        memo = { key, result };
        return { result, snapshot, through: prev.through, writtenFrom: null, monthsWritten: 0, rowsWritten: 0, skipped: true };
      }
      fromMonth = staleFrom(prev, fingerprint, opts.today);
    }
    const snapshot = await loadSnapshot(tx);
    const through = throughMonth(snapshot, opts.today);
    const result = runEngine(snapshot, opts.today, through);
    const first = result.monthList[0] ?? null;

    let from = fromMonth === undefined ? first : fromMonth;
    // a pending invalidation, a new engine version or a shrunken range widen the rewrite
    if (!prev || prev.engineVersion !== ENGINE_VERSION) from = first;
    else {
      if (prev.dirtyFrom && (!from || prev.dirtyFrom < from)) from = prev.dirtyFrom;
      if (prev.firstMonth !== first) from = first;
      // the range grew (assign-ahead): months between the old and new end were never cached
      if (through > prev.through) {
        const gap = addMonths(prev.through, 1);
        if (!from || gap < from) from = gap;
      }
    }
    if (from && first && from < first) from = first;

    await tx.delete(budgetMonthCache).where(ne(budgetMonthCache.engineVersion, ENGINE_VERSION));
    await tx.delete(budgetMonthSummary).where(ne(budgetMonthSummary.engineVersion, ENGINE_VERSION));
    // months past the computed range (an assign-ahead was removed) are no longer valid
    await tx.delete(budgetMonthCache).where(gt(budgetMonthCache.month, through));
    await tx.delete(budgetMonthSummary).where(gt(budgetMonthSummary.month, through));

    let rowsWritten = 0;
    let monthsWritten = 0;
    if (from) {
      await tx.delete(budgetMonthCache).where(and(eq(budgetMonthCache.engineVersion, ENGINE_VERSION), gte(budgetMonthCache.month, from)));
      // Summary rows are all rewritten: displayed RTA / assigned-in-future of a month depend on every
      // later month (assign-ahead, §6.2), so a change in month X moves them for months before X too.
      await tx.delete(budgetMonthSummary).where(eq(budgetMonthSummary.engineVersion, ENGINE_VERSION));
      const known = new Set(snapshot.categories.map((c) => c.id));
      const catRows: (typeof budgetMonthCache.$inferInsert)[] = [];
      const sumRows: (typeof budgetMonthSummary.$inferInsert)[] = [];
      for (const m of result.monthList) {
        const mr = result.months[m]!;
        sumRows.push({
          engineVersion: ENGINE_VERSION,
          month: m,
          rtaMilli: mr.readyToAssignDisplay,
          assignedFutureMilli: mr.assignedInFuture,
          costToBeMeMilli: mr.costToBeMe,
          ageOfMoney: mr.ageOfMoney,
        });
        if (m < from) continue;
        monthsWritten++;
        for (const cm of Object.values(mr.categories)) {
          if (!known.has(cm.categoryId)) continue; // engine-virtual categories (missing payment category, …)
          catRows.push({
            engineVersion: ENGINE_VERSION,
            month: m,
            categoryId: cm.categoryId,
            assignedMilli: cm.assigned,
            activityMilli: cm.activity,
            availableMilli: cm.available,
            carryInMilli: cm.carryIn,
            cashOverspendMilli: cm.cashOverspend,
            creditOverspendMilli: cm.creditOverspend,
            neededMilli: cm.needed,
            underfundedMilli: cm.underfunded,
          });
        }
      }
      for (let i = 0; i < catRows.length; i += 1000) await tx.insert(budgetMonthCache).values(catRows.slice(i, i + 1000));
      for (let i = 0; i < sumRows.length; i += 1000) await tx.insert(budgetMonthSummary).values(sumRows.slice(i, i + 1000));
      rowsWritten = catRows.length;
    }

    await writeCacheState(tx, {
      engineVersion: ENGINE_VERSION,
      fingerprint,
      asOf: opts.today,
      through,
      firstMonth: first,
      dirtyFrom: null,
      computedAt: new Date().toISOString(),
    });
    memo = { key: memoKey(fingerprint, opts.today, through), result };
    return { result, snapshot, through, writtenFrom: monthsWritten > 0 ? from : null, monthsWritten, rowsWritten };
  });
}

export interface FreshBudget {
  /** The engine result for the current data (memo hit or fresh run). */
  result: BudgetResult;
  state: CacheState;
  /** True when this call had to recompute (and rewrite) the cache. */
  recomputed: boolean;
}

/**
 * Make sure the cache matches the data and "today"; recompute when stale. Returns the engine result
 * (memoized per fingerprint, re-run in memory on a cold process without rewriting the cache).
 */
export async function ensureFresh(db: DbLike, today: ISODate): Promise<FreshBudget> {
  const [state, fp] = await inOrder([() => readCacheState(db), () => budgetFingerprint(db)]);
  if (!isCacheFresh(state, fp, today)) {
    // concurrent callers queue on the lock; all but the first find it fresh and skip the rewrite
    const r = await recompute(db, { today, onlyIfStale: true });
    const st = (await readCacheState(db))!;
    return { result: r.result, state: st, recomputed: !r.skipped };
  }
  const key = memoKey(fp, today, state.through);
  if (memo && memo.key === key) return { result: memo.result, state, recomputed: false };
  const snapshot = await loadSnapshot(db);
  const result = runEngine(snapshot, today, state.through);
  memo = { key, result };
  return { result, state, recomputed: false };
}

const minMonth = (a: Month | null, b: Month | null): Month | null => (a === null ? b : b === null ? a : a < b ? a : b);

export interface BudgetWrite {
  /** Recompute after the write: rewrites from min(fromMonth, anything already stale). null = nothing numeric changed. */
  finish(fromMonth: Month | null): Promise<RecomputeResult>;
}

/**
 * Call at the start of every budget-changing write transaction: takes the budget lock and notes whether
 * the cache was current before this write, so `finish` never marks earlier stale months as fresh.
 */
export async function beginBudgetWrite(tx: DbLike, today: ISODate): Promise<BudgetWrite> {
  await lockBudget(tx);
  const [state, fp] = await inOrder([() => readCacheState(tx), () => budgetFingerprint(tx)]);
  // undefined → full rewrite
  let floor: Month | null | undefined;
  if (state && state.engineVersion === ENGINE_VERSION && (state.fingerprint === fp || state.dirtyFrom)) {
    // fresh, or invalidated by a writer that said where its change starts (invalidateBudget)
    floor = state.dirtyFrom ?? null;
    if (state.asOf !== today) floor = minMonth(floor, monthOf(state.asOf < today ? state.asOf : today));
  }
  return {
    finish: (fromMonth) => {
      if (floor === undefined) return recompute(tx, { today });
      const from = minMonth(floor, fromMonth);
      // nothing numeric changed and nothing stale: refresh state only (write from past the range)
      return recompute(tx, { today, fromMonth: from ?? "9999-12-01" });
    },
  };
}
