/**
 * DB rows → engine BudgetSnapshot (spec §6). The engine is pure; this is the only place that knows how
 * the tables map onto its input.
 */
import { asc, isNull, sql } from "drizzle-orm";
import {
  accounts,
  categories,
  categoryGroups,
  monthAssignments,
  payrollRuns,
  scheduledTransactionSplits,
  scheduledTransactions,
  targets,
  transactionSplits,
  transactions,
} from "@homebase/db";
import { monthOf } from "@homebase/shared";
import type {
  BudgetSnapshot,
  EngineScheduledSplit,
  EngineSplit,
  EngineTarget,
  EngineTransaction,
  IncomeBasisOverride,
  Month,
} from "@homebase/engine";
import { inOrder, type DbLike } from "../context";

/** Load everything the engine needs. Soft-deleted transactions are left out (they never count). */
export async function loadSnapshot(db: DbLike): Promise<BudgetSnapshot> {
  const [acctRows, groupRows, catRows, txRows, splitRows, asgRows, targetRows, schedRows, schedSplitRows, payroll] = await inOrder([
    () => db.select({ id: accounts.id, kind: accounts.kind, onBudget: accounts.onBudget, closed: accounts.closed, name: accounts.name }).from(accounts),
    () => db.select({ id: categoryGroups.id, name: categoryGroups.name, sort: categoryGroups.sort, hidden: categoryGroups.hidden }).from(categoryGroups),
    () => db
      .select({
        id: categories.id,
        groupId: categories.groupId,
        name: categories.name,
        kind: categories.kind,
        linkedAccountId: categories.linkedAccountId,
        hidden: categories.hidden,
        sort: categories.sort,
        deletedAt: categories.deletedAt,
      })
      .from(categories),
    () => db
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
    () => db
      .select({
        id: transactionSplits.id,
        transactionId: transactionSplits.transactionId,
        amount: transactionSplits.amountMilli,
        categoryId: transactionSplits.categoryId,
        transferAccountId: transactionSplits.transferAccountId,
      })
      .from(transactionSplits)
      .orderBy(asc(transactionSplits.transactionId), asc(transactionSplits.sort), asc(transactionSplits.id)),
    () => db.select({ month: monthAssignments.month, categoryId: monthAssignments.categoryId, assigned: monthAssignments.assignedMilli }).from(monthAssignments),
    () => db.select().from(targets),
    () => db.select().from(scheduledTransactions).where(isNull(scheduledTransactions.deletedAt)),
    () => db.select().from(scheduledTransactionSplits).orderBy(asc(scheduledTransactionSplits.sort)),
    () => db
      .select({ month: sql<string>`date_trunc('month', ${payrollRuns.checkDate})::date`, gross: sql<bigint>`sum(${payrollRuns.grossMilli})::bigint` })
      .from(payrollRuns)
      .groupBy(sql`1`),
  ]);

  const splitsByTx = new Map<string, EngineSplit[]>();
  for (const s of splitRows) {
    const arr = splitsByTx.get(s.transactionId) ?? [];
    arr.push({ id: s.id, amount: s.amount, categoryId: s.categoryId, transferAccountId: s.transferAccountId });
    splitsByTx.set(s.transactionId, arr);
  }
  const txs: EngineTransaction[] = txRows.map((t) => {
    const e: EngineTransaction = {
      id: t.id,
      accountId: t.accountId,
      date: t.date,
      amount: t.amount,
      categoryId: t.categoryId,
      transferAccountId: t.transferAccountId,
      cleared: t.cleared,
      isStartingBalance: t.isStartingBalance,
    };
    if (t.importOrder !== null) e.importOrder = t.importOrder;
    if (t.isSplit) e.splits = splitsByTx.get(t.id) ?? [];
    return e;
  });

  const schedSplits = new Map<string, EngineScheduledSplit[]>();
  for (const s of schedSplitRows) {
    const arr = schedSplits.get(s.scheduledTransactionId) ?? [];
    arr.push({ amount: s.amountMilli, categoryId: s.categoryId, transferAccountId: s.transferAccountId });
    schedSplits.set(s.scheduledTransactionId, arr);
  }

  const engineTargets: EngineTarget[] = targetRows.map((t) => ({
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
    incomeBasis: t.incomeBasis ?? undefined,
    removed: t.removed,
  }));

  const incomeBasis: IncomeBasisOverride[] = payroll.map((p) => ({ month: monthOf(String(p.month)) as Month, basis: "gross_pay", amount: BigInt(p.gross) }));

  return {
    accounts: acctRows.map((a) => ({ id: a.id, kind: a.kind, onBudget: a.onBudget, closed: a.closed, name: a.name })),
    groups: groupRows.map((g) => ({ id: g.id, name: g.name, sort: g.sort, hidden: g.hidden })),
    categories: catRows.map((c) => ({
      id: c.id,
      groupId: c.groupId,
      name: c.name,
      kind: c.kind,
      linkedAccountId: c.linkedAccountId,
      hidden: c.hidden,
      sort: c.sort,
      deleted: c.deletedAt !== null,
    })),
    transactions: txs,
    assignments: asgRows.map((a) => ({ month: a.month, categoryId: a.categoryId, assigned: a.assigned })),
    targets: engineTargets,
    scheduled: schedRows.map((s) => ({
      id: s.id,
      accountId: s.accountId,
      categoryId: s.categoryId,
      transferAccountId: s.transferAccountId,
      amount: s.amountMilli,
      frequency: s.frequency,
      nextDate: s.nextDate,
      endDate: s.endDate,
      splits: s.isSplit ? (schedSplits.get(s.id) ?? []) : undefined,
    })),
    incomeBasis: incomeBasis.length ? incomeBasis : undefined,
  };
}

/** Latest month with a non-zero assignment (assign-ahead extends the computed range). */
export function lastAssignedMonth(snapshot: BudgetSnapshot): Month | null {
  let last: Month | null = null;
  for (const a of snapshot.assignments) if (a.assigned !== 0n && (!last || a.month > last)) last = a.month;
  return last;
}
