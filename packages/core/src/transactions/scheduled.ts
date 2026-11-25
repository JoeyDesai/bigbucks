/**
 * Scheduled transactions (spec §5.1, §6.8): CRUD and the daily `materializeDue` job, which enters every
 * occurrence up to today as an uncleared, unapproved transaction and advances `next_date`.
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { accounts, categories, payees, scheduledTransactionSplits, scheduledTransactions, transactionSplits, transactions, type ScheduledTransaction } from "@homebase/db";
import { occurrences, type EngineScheduledTransaction } from "@homebase/engine";
import { FLAGS, FREQUENCIES, addDays, monthOf, sumMilli, type ISODate, type Milli } from "@homebase/shared";
import { writeAudit } from "../audit";
import { beginBudgetWrite } from "../budget/cache";
import { ctxToday, withTx, type Ctx, type DbLike } from "../context";
import { NotFoundError, ValidationError } from "../errors";
import { checkCategory, getAccountOrThrow, resolvePayee, transferPayeeFor } from "./common";

const milli = z.union([z.bigint(), z.string().regex(/^-?\d+$/).transform((s) => BigInt(s))]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();

const ScheduledSplitSchema = z.object({ amount: milli, categoryId: uuid.nullable().default(null), memo: z.string().max(500).nullable().optional() });

export const ScheduledInputSchema = z.object({
  accountId: uuid,
  /** First (and next) occurrence. */
  date,
  frequency: z.enum(FREQUENCIES),
  amount: milli,
  payeeId: uuid.nullable().optional(),
  payeeName: z.string().max(200).nullable().optional(),
  categoryId: uuid.nullable().optional(),
  transferAccountId: uuid.nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
  flag: z.enum(FLAGS).nullable().optional(),
  endDate: date.nullable().optional(),
  splits: z.array(ScheduledSplitSchema).optional(),
});
export type ScheduledInput = z.input<typeof ScheduledInputSchema>;

export interface ScheduledRow extends ScheduledTransaction {
  accountName: string;
  payeeName: string | null;
  categoryName: string | null;
  splits: { amount: Milli; categoryId: string | null; memo: string | null }[];
  /** Occurrences in the next `horizonDays` (default 35). */
  upcoming: ISODate[];
}

const toEngine = (s: ScheduledTransaction, nextDate = s.nextDate): EngineScheduledTransaction => ({
  id: s.id,
  accountId: s.accountId,
  categoryId: s.categoryId,
  transferAccountId: s.transferAccountId,
  amount: s.amountMilli,
  frequency: s.frequency,
  nextDate,
  endDate: s.endDate,
});

/** First occurrence strictly after `after`, stepping from next_date (the engine's anchor). */
export function nextOccurrenceAfter(s: ScheduledTransaction, after: ISODate): ISODate | null {
  if (s.frequency === "once") return null;
  const horizon = addDays(after, 800);
  return occurrences(toEngine(s), horizon).find((d) => d > after) ?? null;
}

export async function listScheduled(db: DbLike, opts: { today?: ISODate; horizonDays?: number } = {}): Promise<ScheduledRow[]> {
  const rows = await db
    .select({ s: scheduledTransactions, accountName: accounts.name, payeeName: payees.name, categoryName: categories.name })
    .from(scheduledTransactions)
    .innerJoin(accounts, eq(accounts.id, scheduledTransactions.accountId))
    .leftJoin(payees, eq(payees.id, scheduledTransactions.payeeId))
    .leftJoin(categories, eq(categories.id, scheduledTransactions.categoryId))
    .where(isNull(scheduledTransactions.deletedAt))
    .orderBy(asc(scheduledTransactions.nextDate));
  const splits = await db.select().from(scheduledTransactionSplits).orderBy(asc(scheduledTransactionSplits.sort));
  const until = addDays(opts.today ?? new Date().toISOString().slice(0, 10), opts.horizonDays ?? 35);
  return rows.map(({ s, accountName, payeeName, categoryName }) => ({
    ...s,
    accountName,
    payeeName,
    categoryName,
    splits: splits.filter((x) => x.scheduledTransactionId === s.id).map((x) => ({ amount: x.amountMilli, categoryId: x.categoryId, memo: x.memo })),
    upcoming: occurrences(toEngine(s), until),
  }));
}

function checkSplits(amount: Milli, splits: { amount: Milli }[] | undefined) {
  if (!splits) return;
  if (splits.length < 2) throw new ValidationError("a split needs at least two lines");
  if (sumMilli(splits.map((l) => l.amount)) !== amount) throw new ValidationError("split lines must add up to the amount");
}

export async function createScheduled(ctx: Ctx, input: ScheduledInput): Promise<ScheduledTransaction> {
  const i = ScheduledInputSchema.parse(input);
  checkSplits(i.amount, i.splits);
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    await getAccountOrThrow(tx, i.accountId);
    const counter = i.transferAccountId ? await getAccountOrThrow(tx, i.transferAccountId) : null;
    await checkCategory(tx, i.categoryId ?? null);
    for (const l of i.splits ?? []) await checkCategory(tx, l.categoryId);
    const payeeId = counter ? await transferPayeeFor(tx, counter) : await resolvePayee(tx, i);
    const [row] = await tx
      .insert(scheduledTransactions)
      .values({
        accountId: i.accountId,
        payeeId,
        categoryId: i.splits ? null : (i.categoryId ?? null),
        transferAccountId: counter?.id ?? null,
        isSplit: !!i.splits,
        amountMilli: i.amount,
        frequency: i.frequency,
        firstDate: i.date,
        nextDate: i.date,
        endDate: i.endDate ?? null,
        memo: i.memo ?? null,
        flag: i.flag ?? null,
      })
      .returning();
    if (i.splits) await tx.insert(scheduledTransactionSplits).values(i.splits.map((l, n) => ({ scheduledTransactionId: row!.id, amountMilli: l.amount, categoryId: l.categoryId, memo: l.memo ?? null, sort: n })));
    await writeAudit(tx, c, { action: "scheduled.create", entity: "scheduled_transaction", entityId: row!.id, after: { ...row, splits: i.splits } });
    await w.finish(monthOf(i.date));
    return row!;
  });
}

export async function updateScheduled(ctx: Ctx, id: string, patch: Partial<ScheduledInput>): Promise<ScheduledTransaction> {
  const p = ScheduledInputSchema.partial().parse(patch);
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    const [s] = await tx.select().from(scheduledTransactions).where(and(eq(scheduledTransactions.id, id), isNull(scheduledTransactions.deletedAt)));
    if (!s) throw new NotFoundError("scheduled transaction", id);
    const set: Partial<typeof scheduledTransactions.$inferInsert> = {};
    if (p.accountId) set.accountId = (await getAccountOrThrow(tx, p.accountId)).id;
    if (p.date) {
      set.nextDate = p.date;
      if (p.date < s.firstDate) set.firstDate = p.date;
    }
    if (p.frequency) set.frequency = p.frequency;
    if (p.amount !== undefined) set.amountMilli = p.amount;
    if (p.memo !== undefined) set.memo = p.memo;
    if (p.flag !== undefined) set.flag = p.flag;
    if (p.endDate !== undefined) set.endDate = p.endDate;
    if (p.transferAccountId !== undefined) {
      const counter = p.transferAccountId ? await getAccountOrThrow(tx, p.transferAccountId) : null;
      set.transferAccountId = counter?.id ?? null;
      if (counter) set.payeeId = await transferPayeeFor(tx, counter);
    }
    if (p.payeeId !== undefined || p.payeeName !== undefined) set.payeeId = await resolvePayee(tx, p);
    if (p.categoryId !== undefined) {
      await checkCategory(tx, p.categoryId);
      set.categoryId = p.categoryId;
    }
    const amount = set.amountMilli ?? s.amountMilli;
    if (p.splits) {
      checkSplits(amount, p.splits);
      for (const l of p.splits) await checkCategory(tx, l.categoryId);
      await tx.delete(scheduledTransactionSplits).where(eq(scheduledTransactionSplits.scheduledTransactionId, s.id));
      await tx.insert(scheduledTransactionSplits).values(p.splits.map((l, n) => ({ scheduledTransactionId: s.id, amountMilli: l.amount, categoryId: l.categoryId, memo: l.memo ?? null, sort: n })));
      set.isSplit = true;
      set.categoryId = null;
    } else if (p.categoryId !== undefined && s.isSplit) {
      await tx.delete(scheduledTransactionSplits).where(eq(scheduledTransactionSplits.scheduledTransactionId, s.id));
      set.isSplit = false;
    } else if (s.isSplit && set.amountMilli !== undefined) {
      const lines = await tx.select().from(scheduledTransactionSplits).where(eq(scheduledTransactionSplits.scheduledTransactionId, s.id));
      checkSplits(amount, lines.map((l) => ({ amount: l.amountMilli })));
    }
    const [after] = await tx.update(scheduledTransactions).set(set).where(eq(scheduledTransactions.id, s.id)).returning();
    await writeAudit(tx, c, { action: "scheduled.update", entity: "scheduled_transaction", entityId: s.id, before: s, after });
    await w.finish(monthOf(s.nextDate < (set.nextDate ?? s.nextDate) ? s.nextDate : (set.nextDate ?? s.nextDate)));
    return after!;
  });
}

export async function deleteScheduled(ctx: Ctx, id: string): Promise<void> {
  await withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    const [s] = await tx.update(scheduledTransactions).set({ deletedAt: new Date() }).where(and(eq(scheduledTransactions.id, id), isNull(scheduledTransactions.deletedAt))).returning();
    if (!s) throw new NotFoundError("scheduled transaction", id);
    await writeAudit(tx, c, { action: "scheduled.delete", entity: "scheduled_transaction", entityId: id, before: s });
    await w.finish(monthOf(s.nextDate));
  });
}

export interface MaterializeResult {
  created: { scheduledId: string; transactionId: string; date: ISODate }[];
  advanced: { scheduledId: string; nextDate: ISODate | null }[];
}

/**
 * Daily job (§8.1 `scheduled.materialize`): enter each due occurrence (≤ today) once — idempotent per
 * (scheduled id, date) — as uncleared + unapproved, then move next_date past today (or end the schedule).
 */
export async function materializeDue(ctx: Ctx, today?: ISODate): Promise<MaterializeResult> {
  const day = today ?? ctxToday(ctx);
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, day);
    const due = await tx
      .select()
      .from(scheduledTransactions)
      .where(and(isNull(scheduledTransactions.deletedAt)))
      .for("update");
    const out: MaterializeResult = { created: [], advanced: [] };
    let earliest: ISODate | null = null;
    for (const s of due) {
      if (s.nextDate > day) continue;
      const dates = occurrences(toEngine(s), day);
      const lines = s.isSplit ? await tx.select().from(scheduledTransactionSplits).where(eq(scheduledTransactionSplits.scheduledTransactionId, s.id)).orderBy(asc(scheduledTransactionSplits.sort)) : [];
      const acct = await getAccountOrThrow(tx, s.accountId);
      const counter = s.transferAccountId ? await getAccountOrThrow(tx, s.transferAccountId) : null;
      for (const d of dates) {
        const exists = await tx
          .select({ id: transactions.id })
          .from(transactions)
          .where(and(eq(transactions.scheduledTransactionId, s.id), eq(transactions.date, d), eq(transactions.accountId, s.accountId)))
          .limit(1);
        if (exists.length) continue;
        const keepCat = !counter || (acct.onBudget && !counter.onBudget);
        const [t] = await tx
          .insert(transactions)
          .values({
            accountId: s.accountId,
            date: d,
            amountMilli: s.amountMilli,
            payeeId: s.payeeId,
            memo: s.memo,
            categoryId: s.isSplit || !keepCat ? null : s.categoryId,
            isSplit: s.isSplit,
            transferAccountId: counter?.id ?? null,
            cleared: "uncleared",
            approved: false,
            flag: s.flag,
            source: "scheduled",
            scheduledTransactionId: s.id,
          })
          .returning({ id: transactions.id });
        if (lines.length) await tx.insert(transactionSplits).values(lines.map((l) => ({ transactionId: t!.id, amountMilli: l.amountMilli, categoryId: l.categoryId, payeeId: l.payeeId, memo: l.memo, sort: l.sort })));
        if (counter) {
          const [pair] = await tx
            .insert(transactions)
            .values({
              accountId: counter.id,
              date: d,
              amountMilli: -s.amountMilli,
              payeeId: await transferPayeeFor(tx, acct),
              memo: s.memo,
              categoryId: counter.onBudget && !acct.onBudget ? s.categoryId : null,
              transferAccountId: acct.id,
              transferPairId: t!.id,
              cleared: "uncleared",
              approved: false,
              source: "scheduled",
              scheduledTransactionId: s.id,
            })
            .returning({ id: transactions.id });
          await tx.update(transactions).set({ transferPairId: pair!.id }).where(eq(transactions.id, t!.id));
        }
        out.created.push({ scheduledId: s.id, transactionId: t!.id, date: d });
        if (!earliest || d < earliest) earliest = d;
      }
      const next = nextOccurrenceAfter(s, day);
      const ended = next === null || (s.endDate !== null && next > s.endDate);
      await tx
        .update(scheduledTransactions)
        .set(ended ? { deletedAt: new Date() } : { nextDate: next! })
        .where(eq(scheduledTransactions.id, s.id));
      out.advanced.push({ scheduledId: s.id, nextDate: ended ? null : next });
    }
    if (out.created.length || out.advanced.length) await writeAudit(tx, c, { action: "scheduled.materialize", entity: "scheduled_transaction", after: { day, ...out } });
    await w.finish(earliest ? monthOf(earliest) : out.advanced.length ? monthOf(day) : null);
    return out;
  });
}
