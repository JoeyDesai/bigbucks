/**
 * Budget cache refresh (§6: "The DB layer caches results in budget_month_cache and recomputes from
 * the earliest month that changed").
 *
 * `@homebase/core` owns this (`recompute(db, { fromMonth, today })`) and is what jobs use. The local
 * snapshot loader/recompute below stays for parity checks and tests that must not depend on core's
 * cache-state bookkeeping.
 */
import { and, asc, eq, gte, isNull } from "drizzle-orm";
import {
  accounts,
  budgetMonthCache,
  budgetMonthSummary,
  categories,
  categoryGroups,
  monthAssignments,
  scheduledTransactions,
  scheduledTransactionSplits,
  targets,
  transactions,
  transactionSplits,
  type Db,
} from "@homebase/db";
import { computeBudget, ENGINE_VERSION, type BudgetOptions, type BudgetResult, type BudgetSnapshot, type EngineSplit, type EngineScheduledSplit } from "@homebase/engine";
import { currentMonth, monthOf, today, type Month } from "@homebase/shared";
import { recompute as coreRecompute } from "@homebase/core";
import type { RecomputeFn } from "./hooks";

/** Load the full engine snapshot from the DB (ids are DB uuids). Soft-deleted transactions are left out. */
export async function loadBudgetSnapshot(db: Db): Promise<BudgetSnapshot> {
  const [acctRows, groupRows, catRows, txRows, splitRows, assignRows, targetRows, schedRows, schedSplitRows] = await Promise.all([
    db.select().from(accounts).orderBy(asc(accounts.sort), asc(accounts.id)),
    db.select().from(categoryGroups).orderBy(asc(categoryGroups.sort), asc(categoryGroups.id)),
    db.select().from(categories).orderBy(asc(categories.sort), asc(categories.id)),
    db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        date: transactions.date,
        amount: transactions.amountMilli,
        categoryId: transactions.categoryId,
        transferAccountId: transactions.transferAccountId,
        cleared: transactions.cleared,
        importOrder: transactions.importOrder,
        isSplit: transactions.isSplit,
        isStartingBalance: transactions.isStartingBalance,
      })
      .from(transactions)
      .where(isNull(transactions.deletedAt)),
    db
      .select({ id: transactionSplits.id, transactionId: transactionSplits.transactionId, amount: transactionSplits.amountMilli, categoryId: transactionSplits.categoryId, transferAccountId: transactionSplits.transferAccountId, sort: transactionSplits.sort })
      .from(transactionSplits)
      .orderBy(asc(transactionSplits.sort), asc(transactionSplits.id)),
    db.select().from(monthAssignments),
    db.select().from(targets),
    db.select().from(scheduledTransactions),
    db.select().from(scheduledTransactionSplits).orderBy(asc(scheduledTransactionSplits.sort)),
  ]);

  const splitsByTxn = new Map<string, EngineSplit[]>();
  for (const s of splitRows) {
    const l = splitsByTxn.get(s.transactionId) ?? [];
    l.push({ id: s.id, amount: s.amount, categoryId: s.categoryId, transferAccountId: s.transferAccountId });
    splitsByTxn.set(s.transactionId, l);
  }
  const schedSplits = new Map<string, EngineScheduledSplit[]>();
  for (const s of schedSplitRows) {
    const l = schedSplits.get(s.scheduledTransactionId) ?? [];
    l.push({ amount: s.amountMilli, categoryId: s.categoryId, transferAccountId: s.transferAccountId });
    schedSplits.set(s.scheduledTransactionId, l);
  }

  return {
    accounts: acctRows.map((a) => ({ id: a.id, kind: a.kind, onBudget: a.onBudget, closed: a.closed || a.deletedAt !== null, name: a.name })),
    groups: groupRows.map((g) => ({ id: g.id, name: g.name, sort: g.sort, hidden: g.hidden || g.deletedAt !== null })),
    categories: catRows.map((c) => ({ id: c.id, groupId: c.groupId, name: c.name, kind: c.kind, linkedAccountId: c.linkedAccountId, hidden: c.hidden, sort: c.sort, deleted: c.deletedAt !== null })),
    transactions: txRows.map((t) => {
      const splits = t.isSplit ? splitsByTxn.get(t.id) : undefined;
      return {
        id: t.id,
        accountId: t.accountId,
        date: t.date,
        amount: t.amount,
        categoryId: splits?.length ? null : t.categoryId,
        transferAccountId: t.transferAccountId,
        cleared: t.cleared,
        ...(t.importOrder !== null ? { importOrder: t.importOrder } : {}),
        ...(splits?.length ? { splits } : {}),
        isStartingBalance: t.isStartingBalance,
      };
    }),
    assignments: assignRows.map((a) => ({ month: a.month, categoryId: a.categoryId, assigned: a.assignedMilli })),
    targets: targetRows.map((t) => ({
      categoryId: t.categoryId,
      effectiveFrom: t.effectiveFrom,
      type: t.type,
      amount: t.amountMilli,
      cadence: t.cadence,
      cadenceEvery: t.cadenceEvery,
      day: t.day,
      targetDate: t.targetDate,
      percent: t.percent,
      snoozedMonth: t.snoozedMonth,
      createdMonth: t.createdMonth,
      ...(t.incomeBasis ? { incomeBasis: t.incomeBasis } : {}),
      removed: t.removed,
    })),
    scheduled: schedRows.map((s) => {
      const splits = s.isSplit ? schedSplits.get(s.id) : undefined;
      return {
        id: s.id,
        accountId: s.accountId,
        categoryId: s.categoryId,
        transferAccountId: s.transferAccountId,
        amount: s.amountMilli,
        frequency: s.frequency,
        nextDate: s.nextDate,
        endDate: s.endDate,
        ...(splits?.length ? { splits } : {}),
        deleted: s.deletedAt !== null,
      };
    }),
  };
}

/** Last month the budget should cover: the later of this month and any assignment/transaction month. */
export function throughMonth(s: BudgetSnapshot, now: Month = currentMonth()): Month {
  let m = now;
  for (const a of s.assignments) if (a.month > m) m = a.month;
  for (const t of s.transactions) if (monthOf(t.date) > m) m = monthOf(t.date);
  return m;
}

export interface LocalRecomputeOptions {
  fromMonth?: Month | null;
  /** Budget option overrides (golden-run switches). */
  budget?: Partial<BudgetOptions>;
  asOf?: string;
}

/** Compute and cache. Returns the engine result for the cached months. */
export async function recomputeBudget(db: Db, o: LocalRecomputeOptions = {}): Promise<BudgetResult> {
  const snap = await loadBudgetSnapshot(db);
  const through = throughMonth(snap);
  const from = o.fromMonth ?? undefined;
  const result = computeBudget(snap, { ...o.budget, through, ...(from ? { from } : {}), asOf: o.asOf ?? today() });
  const known = new Set(snap.categories.map((c) => c.id));
  const months = result.monthList.filter((m) => !from || m >= from);

  await db.transaction(async (tx) => {
    const cond = from ? and(eq(budgetMonthCache.engineVersion, ENGINE_VERSION), gte(budgetMonthCache.month, from)) : eq(budgetMonthCache.engineVersion, ENGINE_VERSION);
    await tx.delete(budgetMonthCache).where(cond);
    await tx.delete(budgetMonthSummary).where(from ? and(eq(budgetMonthSummary.engineVersion, ENGINE_VERSION), gte(budgetMonthSummary.month, from)) : eq(budgetMonthSummary.engineVersion, ENGINE_VERSION));
    const cacheRows: (typeof budgetMonthCache.$inferInsert)[] = [];
    const summaryRows: (typeof budgetMonthSummary.$inferInsert)[] = [];
    for (const m of months) {
      const mr = result.months[m]!;
      summaryRows.push({ engineVersion: ENGINE_VERSION, month: m, rtaMilli: mr.readyToAssignDisplay, assignedFutureMilli: mr.assignedInFuture, costToBeMeMilli: mr.costToBeMe, ageOfMoney: mr.ageOfMoney });
      for (const c of Object.values(mr.categories)) {
        if (!known.has(c.categoryId)) continue; // virtual categories (implicit uncategorized / missing P(K))
        cacheRows.push({
          engineVersion: ENGINE_VERSION,
          month: m,
          categoryId: c.categoryId,
          assignedMilli: c.assigned,
          activityMilli: c.activity,
          availableMilli: c.available,
          carryInMilli: c.carryIn,
          cashOverspendMilli: c.cashOverspend,
          creditOverspendMilli: c.creditOverspend,
          neededMilli: c.needed,
          underfundedMilli: c.underfunded,
        });
      }
    }
    for (let i = 0; i < cacheRows.length; i += 1000) await tx.insert(budgetMonthCache).values(cacheRows.slice(i, i + 1000));
    for (let i = 0; i < summaryRows.length; i += 1000) await tx.insert(budgetMonthSummary).values(summaryRows.slice(i, i + 1000));
  });
  return result;
}

/**
 * Production recompute: `@homebase/core`'s `recompute` (advisory lock, REPEATABLE READ, cache-state
 * fingerprint so the web app's reads agree it is fresh).
 */
export const defaultRecompute: RecomputeFn = (db, opts) => coreRecompute(db, { fromMonth: opts.fromMonth ?? null, today: today() });

/** Local-only recompute (tests, CLIs that must not depend on core's progress). */
export const localRecompute: RecomputeFn = (db, opts) => recomputeBudget(db, { fromMonth: opts.fromMonth ?? null });
