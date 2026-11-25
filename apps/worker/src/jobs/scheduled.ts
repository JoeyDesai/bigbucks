/**
 * scheduled.materialize (daily 00:10): enter every scheduled occurrence due on or before today as a
 * real transaction (source `scheduled`, uncleared, approved — the user scheduled it), then advance
 * `next_date` (frequency "once" → soft-deleted; past `end_date` → soft-deleted). Transfers create both
 * sides, paired. The bank's version later replaces it via §8.4 scheduled → synced matching.
 *
 * During the §10 parallel run YNAB enters its own scheduled transactions and the delta import brings
 * them in, so materializing here too would double-count: the job is skipped while the run is active.
 */
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { accounts, scheduledTransactions, scheduledTransactionSplits, transactions, transactionSplits } from "@homebase/db";
import { occurrences } from "@homebase/engine";
import { addDays, monthOf, type Month } from "@homebase/shared";
import { todayOf, type WorkerContext } from "../context";
import { parallelRunState } from "../settings";

export interface MaterializeResult {
  created: number;
  advanced: number;
  finished: number;
  skipped?: string;
  earliestMonth: Month | null;
}

export async function materializeScheduled(ctx: Pick<WorkerContext, "db" | "now" | "log" | "recompute">, o: { force?: boolean } = {}): Promise<MaterializeResult> {
  const today = todayOf(ctx);
  const out: MaterializeResult = { created: 0, advanced: 0, finished: 0, earliestMonth: null };
  if (!o.force && (await parallelRunState(ctx.db, today)).active) return { ...out, skipped: "YNAB parallel run active (YNAB enters scheduled transactions)" };

  const due = await ctx.db
    .select()
    .from(scheduledTransactions)
    .where(and(isNull(scheduledTransactions.deletedAt), lte(scheduledTransactions.nextDate, today)))
    .orderBy(asc(scheduledTransactions.nextDate));
  if (!due.length) return out;
  const onBudget = new Map((await ctx.db.select({ id: accounts.id, onBudget: accounts.onBudget }).from(accounts)).map((a) => [a.id, a.onBudget]));

  await ctx.db.transaction(async (tx) => {
    for (const s of due) {
      const splits = s.isSplit ? await tx.select().from(scheduledTransactionSplits).where(eq(scheduledTransactionSplits.scheduledTransactionId, s.id)).orderBy(asc(scheduledTransactionSplits.sort)) : [];
      const engineSched = { id: s.id, accountId: s.accountId, categoryId: s.categoryId, transferAccountId: s.transferAccountId, amount: s.amountMilli, frequency: s.frequency, nextDate: s.nextDate, endDate: s.endDate };
      // All occurrences through today, plus the first one after (the new next_date).
      const dates = occurrences(engineSched, addDays(today, 800));
      const toEnter = dates.filter((d) => d <= today);
      const next = dates.find((d) => d > today) ?? null;
      for (const date of toEnter) {
        const bothOnBudget = s.transferAccountId ? onBudget.get(s.accountId) && onBudget.get(s.transferAccountId) : false;
        const [row] = await tx
          .insert(transactions)
          .values({
            accountId: s.accountId,
            date,
            amountMilli: s.amountMilli,
            payeeId: s.payeeId,
            memo: s.memo,
            categoryId: s.isSplit || bothOnBudget ? null : s.categoryId,
            isSplit: s.isSplit,
            transferAccountId: s.transferAccountId,
            cleared: "uncleared",
            approved: true,
            flag: s.flag,
            source: "scheduled",
            scheduledTransactionId: s.id,
          })
          .returning({ id: transactions.id });
        if (splits.length) {
          await tx.insert(transactionSplits).values(splits.map((l, k) => ({ transactionId: row!.id, amountMilli: l.amountMilli, categoryId: l.categoryId, payeeId: l.payeeId, memo: l.memo, transferAccountId: l.transferAccountId, sort: k })));
        }
        if (s.transferAccountId) {
          const [other] = await tx
            .insert(transactions)
            .values({ accountId: s.transferAccountId, date, amountMilli: -s.amountMilli, payeeId: null, memo: s.memo, transferAccountId: s.accountId, transferPairId: row!.id, cleared: "uncleared", approved: true, source: "scheduled", scheduledTransactionId: s.id })
            .returning({ id: transactions.id });
          await tx.update(transactions).set({ transferPairId: other!.id }).where(eq(transactions.id, row!.id));
        }
        out.created++;
        const m = monthOf(date);
        if (!out.earliestMonth || m < out.earliestMonth) out.earliestMonth = m;
      }
      if (next && (!s.endDate || next <= s.endDate) && s.frequency !== "once") {
        await tx.update(scheduledTransactions).set({ nextDate: next, updatedAt: ctx.now() }).where(eq(scheduledTransactions.id, s.id));
        out.advanced++;
      } else {
        await tx.update(scheduledTransactions).set({ deletedAt: ctx.now(), updatedAt: ctx.now() }).where(eq(scheduledTransactions.id, s.id));
        out.finished++;
      }
    }
  });
  if (out.earliestMonth) await ctx.recompute(ctx.db, { fromMonth: out.earliestMonth });
  return out;
}

