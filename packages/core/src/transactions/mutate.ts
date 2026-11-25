/**
 * Transaction writes (spec §12.2, §11.3 write tools): create, update, split, mark transfer, approve,
 * delete, recategorize. Each is one transaction that audits, logs category changes (§9.5) and refreshes
 * the engine cache from the earliest affected month.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { transactionSplits, transactions, type Transaction } from "@homebase/db";
import { CLEARED, FLAGS, sumMilli, type Milli } from "@homebase/shared";
import { writeAudit } from "../audit";
import { beginBudgetWrite } from "../budget/cache";
import { ctxToday, withTx, type Ctx } from "../context";
import { ValidationError } from "../errors";
import { checkCategory, getAccountOrThrow, getTxOrThrow, logCategoryChange, minMonth, resolvePayee, transferPayeeFor, userCatz } from "./common";

const milli = z.union([z.bigint(), z.string().regex(/^-?\d+$/).transform((s) => BigInt(s))]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();

export const SplitLineSchema = z.object({
  amount: milli,
  categoryId: uuid.nullable().default(null),
  payeeId: uuid.nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
});
export type SplitLineInput = z.input<typeof SplitLineSchema>;

export const CreateTransactionSchema = z.object({
  accountId: uuid,
  date,
  amount: milli,
  payeeId: uuid.nullable().optional(),
  payeeName: z.string().max(200).nullable().optional(),
  categoryId: uuid.nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
  cleared: z.enum(CLEARED).default("uncleared"),
  approved: z.boolean().default(true),
  flag: z.enum(FLAGS).nullable().optional(),
  splits: z.array(SplitLineSchema).optional(),
  /** Creates the counterpart in this account and links the pair. */
  transferAccountId: uuid.nullable().optional(),
});
export type CreateTransactionInput = z.input<typeof CreateTransactionSchema>;

function validateSplit(amount: Milli, lines: { amount: Milli }[]): void {
  if (lines.length < 2) throw new ValidationError("a split needs at least two lines");
  const total = sumMilli(lines.map((l) => l.amount));
  if (total !== amount) throw new ValidationError(`split lines add up to ${total}, expected ${amount}`);
}

async function insertSplits(tx: Ctx["db"], transactionId: string, lines: z.output<typeof SplitLineSchema>[]): Promise<void> {
  for (const l of lines) await checkCategory(tx, l.categoryId);
  await tx.insert(transactionSplits).values(
    lines.map((l, i) => ({ transactionId, amountMilli: l.amount, categoryId: l.categoryId, payeeId: l.payeeId ?? null, memo: l.memo ?? null, sort: i })),
  );
}

/** Manual transaction (the register's + button). */
export async function createTransaction(ctx: Ctx, input: CreateTransactionInput): Promise<Transaction> {
  const i = CreateTransactionSchema.parse(input);
  if (i.splits && i.transferAccountId) throw new ValidationError("a split can't also be a transfer");
  if (i.splits) validateSplit(i.amount, i.splits);
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    const acct = await getAccountOrThrow(tx, i.accountId);
    const counter = i.transferAccountId ? await getAccountOrThrow(tx, i.transferAccountId) : null;
    if (counter && counter.id === acct.id) throw new ValidationError("can't transfer to the same account");
    let categoryId = i.splits ? null : (i.categoryId ?? null);
    if (counter && !(acct.onBudget && !counter.onBudget)) categoryId = null; // only the budget side of a boundary-crossing transfer keeps a category
    await checkCategory(tx, categoryId);
    const payeeId = counter ? await transferPayeeFor(tx, counter) : await resolvePayee(tx, i);
    const [row] = await tx
      .insert(transactions)
      .values({
        accountId: acct.id,
        date: i.date,
        amountMilli: i.amount,
        payeeId,
        memo: i.memo ?? null,
        categoryId,
        isSplit: !!i.splits,
        transferAccountId: counter?.id ?? null,
        cleared: i.cleared,
        approved: i.approved,
        flag: i.flag ?? null,
        source: "manual",
        catz: categoryId || i.splits ? userCatz() : null,
      })
      .returning();
    const t = row!;
    if (i.splits) await insertSplits(tx, t.id, i.splits);
    if (counter) {
      const [pair] = await tx
        .insert(transactions)
        .values({
          accountId: counter.id,
          date: i.date,
          amountMilli: -i.amount,
          payeeId: await transferPayeeFor(tx, acct),
          memo: i.memo ?? null,
          categoryId: counter.onBudget && !acct.onBudget ? (i.categoryId ?? null) : null,
          transferAccountId: acct.id,
          transferPairId: t.id,
          cleared: "uncleared",
          approved: true,
          source: "manual",
        })
        .returning({ id: transactions.id });
      await tx.update(transactions).set({ transferPairId: pair!.id }).where(eq(transactions.id, t.id));
      t.transferPairId = pair!.id;
    }
    if (categoryId) await logCategoryChange(tx, c, { id: t.id, categoryId: null, catz: null }, categoryId);
    if (i.splits) for (const l of i.splits) if (l.categoryId) await logCategoryChange(tx, c, { id: t.id, categoryId: null, catz: null }, l.categoryId);
    await writeAudit(tx, c, { action: "transaction.create", entity: "transaction", entityId: t.id, after: { ...t, splits: i.splits } });
    await w.finish(minMonth(i.date));
    return t;
  });
}
/** Alias matching the spec's wording ("createManual"). */
export const createManual = createTransaction;

export const UpdateTransactionSchema = z.object({
  date: date.optional(),
  amount: milli.optional(),
  payeeId: uuid.nullable().optional(),
  payeeName: z.string().max(200).nullable().optional(),
  /** Setting a category on a split transaction un-splits it. null = uncategorized. */
  categoryId: uuid.nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
  flag: z.enum(FLAGS).nullable().optional(),
  cleared: z.enum(CLEARED).optional(),
  approved: z.boolean().optional(),
});
export type UpdateTransactionInput = z.input<typeof UpdateTransactionSchema>;

export async function updateTransaction(ctx: Ctx, id: string, patch: UpdateTransactionInput): Promise<Transaction> {
  const p = UpdateTransactionSchema.parse(patch);
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    const t = await getTxOrThrow(tx, id, { forUpdate: true });
    const set: Partial<typeof transactions.$inferInsert> = {};
    if (p.date !== undefined) set.date = p.date;
    if (p.amount !== undefined && p.amount !== t.amountMilli) {
      if (t.isSplit && p.categoryId === undefined) throw new ValidationError("change the split lines to change a split transaction's amount");
      set.amountMilli = p.amount;
    }
    if (p.payeeId !== undefined || p.payeeName !== undefined) {
      if (t.transferAccountId) throw new ValidationError("a transfer's payee is its account; un-link the transfer first");
      set.payeeId = await resolvePayee(tx, { payeeId: p.payeeId, payeeName: p.payeeName });
    }
    if (p.memo !== undefined) set.memo = p.memo;
    if (p.flag !== undefined) set.flag = p.flag;
    if (p.cleared !== undefined) set.cleared = p.cleared;
    if (p.approved !== undefined) set.approved = p.approved;
    let categoryChanged = false;
    if (p.categoryId !== undefined && (p.categoryId !== t.categoryId || t.isSplit)) {
      if (t.transferAccountId) {
        const counter = await getAccountOrThrow(tx, t.transferAccountId);
        const acct = await getAccountOrThrow(tx, t.accountId);
        if (!(acct.onBudget && !counter.onBudget) && p.categoryId !== null) throw new ValidationError("transfers between budget accounts have no category");
      }
      await checkCategory(tx, p.categoryId);
      set.categoryId = p.categoryId;
      set.catz = userCatz();
      if (t.isSplit) {
        await tx.delete(transactionSplits).where(eq(transactionSplits.transactionId, t.id));
        set.isSplit = false;
      }
      categoryChanged = true;
    }
    if (Object.keys(set).length === 0) {
      await w.finish(null);
      return t;
    }
    const [after] = await tx.update(transactions).set(set).where(eq(transactions.id, t.id)).returning();
    if (t.transferPairId && (set.date !== undefined || set.amountMilli !== undefined)) {
      const pairSet: Partial<typeof transactions.$inferInsert> = {};
      if (set.date !== undefined) pairSet.date = set.date;
      if (set.amountMilli !== undefined) pairSet.amountMilli = -set.amountMilli;
      await tx.update(transactions).set(pairSet).where(eq(transactions.id, t.transferPairId));
    }
    if (categoryChanged) await logCategoryChange(tx, c, t, p.categoryId ?? null);
    await writeAudit(tx, c, { action: "transaction.update", entity: "transaction", entityId: t.id, before: t, after });
    await w.finish(minMonth(t.date, set.date));
    return after!;
  });
}

/** Replace a transaction's split lines (Σ lines must equal the amount). */
export async function splitTransaction(ctx: Ctx, id: string, lines: SplitLineInput[]): Promise<Transaction> {
  const parsed = z.array(SplitLineSchema).parse(lines);
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    const t = await getTxOrThrow(tx, id, { forUpdate: true });
    if (t.transferAccountId) throw new ValidationError("a transfer can't be split");
    validateSplit(t.amountMilli, parsed);
    const before = await tx.select().from(transactionSplits).where(eq(transactionSplits.transactionId, t.id));
    await tx.delete(transactionSplits).where(eq(transactionSplits.transactionId, t.id));
    await insertSplits(tx, t.id, parsed);
    const [after] = await tx.update(transactions).set({ isSplit: true, categoryId: null, catz: userCatz() }).where(eq(transactions.id, t.id)).returning();
    for (const l of parsed) await logCategoryChange(tx, c, t, l.categoryId);
    await writeAudit(tx, c, { action: "transaction.split", entity: "transaction", entityId: t.id, before: { categoryId: t.categoryId, splits: before }, after: { splits: parsed } });
    await w.finish(minMonth(t.date));
    return after!;
  });
}

/**
 * Mark a transaction as a transfer to/from `accountId`: links it to `pairWithId` (an existing opposite
 * transaction in that account) or creates the counterpart. Only the budget side of a transfer that
 * crosses the budget boundary keeps a category (§6.1).
 */
export async function markTransfer(ctx: Ctx, id: string, input: { accountId: string; pairWithId?: string | null }): Promise<{ transaction: Transaction; pair: Transaction }> {
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    const t = await getTxOrThrow(tx, id, { forUpdate: true });
    if (t.isSplit) throw new ValidationError("a split transaction can't be a transfer");
    if (t.transferAccountId) throw new ValidationError("already a transfer");
    const acct = await getAccountOrThrow(tx, t.accountId);
    const counter = await getAccountOrThrow(tx, input.accountId);
    if (counter.id === acct.id) throw new ValidationError("can't transfer to the same account");
    const keepCategory = acct.onBudget && !counter.onBudget;
    let pair: Transaction;
    if (input.pairWithId) {
      const o = await getTxOrThrow(tx, input.pairWithId, { forUpdate: true });
      if (o.accountId !== counter.id) throw new ValidationError("the other transaction is in a different account");
      if (o.amountMilli !== -t.amountMilli) throw new ValidationError("transfer amounts must be equal and opposite");
      if (o.transferAccountId || o.isSplit) throw new ValidationError("the other transaction is already a transfer or split");
      const oCat = counter.onBudget && !acct.onBudget ? o.categoryId : null;
      [pair] = (await tx
        .update(transactions)
        .set({ transferAccountId: acct.id, transferPairId: t.id, categoryId: oCat, payeeId: await transferPayeeFor(tx, acct) })
        .where(eq(transactions.id, o.id))
        .returning()) as [Transaction];
      if (o.categoryId !== oCat) await logCategoryChange(tx, c, o, oCat);
    } else {
      [pair] = (await tx
        .insert(transactions)
        .values({
          accountId: counter.id,
          date: t.date,
          amountMilli: -t.amountMilli,
          payeeId: await transferPayeeFor(tx, acct),
          memo: t.memo,
          transferAccountId: acct.id,
          transferPairId: t.id,
          cleared: "uncleared",
          approved: true,
          source: "manual",
        })
        .returning()) as [Transaction];
    }
    const newCat = keepCategory ? t.categoryId : null;
    const [after] = await tx
      .update(transactions)
      .set({ transferAccountId: counter.id, transferPairId: pair.id, categoryId: newCat, payeeId: await transferPayeeFor(tx, counter), catz: { method: "transfer", confidence: 1, at: new Date().toISOString() } })
      .where(eq(transactions.id, t.id))
      .returning();
    if (t.categoryId !== newCat) await logCategoryChange(tx, c, t, newCat);
    await writeAudit(tx, c, { action: "transaction.mark_transfer", entity: "transaction", entityId: t.id, before: t, after: { ...after, pairId: pair.id } });
    await w.finish(minMonth(t.date, pair.date));
    return { transaction: after!, pair };
  });
}

/** Approve transactions; pending categorization events are closed (accepted = suggestion kept). */
export async function approveTransactions(ctx: Ctx, ids: string[]): Promise<{ approved: string[] }> {
  if (!ids.length) return { approved: [] };
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    const rows = await tx
      .update(transactions)
      .set({ approved: true })
      .where(and(inArray(transactions.id, ids), isNull(transactions.deletedAt), eq(transactions.approved, false)))
      .returning({ id: transactions.id, categoryId: transactions.categoryId });
    for (const r of rows) {
      await tx.execute(sql`UPDATE categorization_events SET final_category_id = ${r.categoryId}::uuid,
        accepted = (suggested_category_id IS NOT DISTINCT FROM ${r.categoryId}::uuid), updated_at = now()
        WHERE transaction_id = ${r.id} AND accepted IS NULL AND NOT shadow AND method <> 'user'`);
    }
    if (rows.length) await writeAudit(tx, c, { action: "transaction.approve", entity: "transaction", entityId: rows.length === 1 ? rows[0]!.id : null, after: { ids: rows.map((r) => r.id) } });
    await w.finish(null);
    return { approved: rows.map((r) => r.id) };
  });
}
export const approve = approveTransactions;

export async function unapproveTransactions(ctx: Ctx, ids: string[]): Promise<{ unapproved: string[] }> {
  if (!ids.length) return { unapproved: [] };
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    const rows = await tx
      .update(transactions)
      .set({ approved: false })
      .where(and(inArray(transactions.id, ids), isNull(transactions.deletedAt), eq(transactions.approved, true)))
      .returning({ id: transactions.id });
    if (rows.length) await writeAudit(tx, c, { action: "transaction.unapprove", entity: "transaction", entityId: rows.length === 1 ? rows[0]!.id : null, after: { ids: rows.map((r) => r.id) } });
    await w.finish(null);
    return { unapproved: rows.map((r) => r.id) };
  });
}
export const unapprove = unapproveTransactions;

/** Soft delete (and the other side of a transfer). */
export async function deleteTransactions(ctx: Ctx, ids: string[]): Promise<{ deleted: string[] }> {
  if (!ids.length) return { deleted: [] };
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    const rows = await tx.select().from(transactions).where(and(inArray(transactions.id, ids), isNull(transactions.deletedAt)));
    const all = new Set(rows.map((r) => r.id));
    for (const r of rows) if (r.transferPairId) all.add(r.transferPairId);
    const deleted = await tx
      .update(transactions)
      .set({ deletedAt: new Date() })
      .where(and(inArray(transactions.id, [...all]), isNull(transactions.deletedAt)))
      .returning({ id: transactions.id, date: transactions.date });
    for (const r of rows) await writeAudit(tx, c, { action: "transaction.delete", entity: "transaction", entityId: r.id, before: r });
    await w.finish(minMonth(...deleted.map((d) => d.date)));
    return { deleted: deleted.map((d) => d.id) };
  });
}

export interface RecategorizeResult {
  updated: string[];
  skipped: { id: string; reason: string }[];
  /** Σ amount of the updated transactions. */
  total: Milli;
}

/**
 * Set the category of many transactions (§11.3 `recategorize`). Each change writes a categorization
 * event. Split transactions and transfers between budget accounts are skipped (with a reason).
 */
export async function recategorize(ctx: Ctx, ids: string[], categoryId: string | null, opts: { approve?: boolean } = {}): Promise<RecategorizeResult> {
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    await checkCategory(tx, categoryId);
    const rows = ids.length ? await tx.select().from(transactions).where(and(inArray(transactions.id, ids), isNull(transactions.deletedAt))).for("update") : [];
    const found = new Set(rows.map((r) => r.id));
    const skipped: RecategorizeResult["skipped"] = ids.filter((id) => !found.has(id)).map((id) => ({ id, reason: "not found" }));
    const updated: string[] = [];
    let total = 0n;
    const dates: string[] = [];
    for (const t of rows) {
      if (t.isSplit) {
        skipped.push({ id: t.id, reason: "split transaction" });
        continue;
      }
      if (t.transferAccountId) {
        const acct = await getAccountOrThrow(tx, t.accountId);
        const counter = await getAccountOrThrow(tx, t.transferAccountId);
        if (!(acct.onBudget && !counter.onBudget)) {
          skipped.push({ id: t.id, reason: "transfer between budget accounts" });
          continue;
        }
      }
      const set: Partial<typeof transactions.$inferInsert> = {};
      if (t.categoryId !== categoryId) {
        set.categoryId = categoryId;
        set.catz = userCatz();
      }
      if (opts.approve && !t.approved) set.approved = true;
      if (Object.keys(set).length === 0) continue;
      await tx.update(transactions).set(set).where(eq(transactions.id, t.id));
      if (t.categoryId !== categoryId) {
        await logCategoryChange(tx, c, t, categoryId);
        dates.push(t.date);
      }
      updated.push(t.id);
      total += t.amountMilli;
    }
    if (updated.length) await writeAudit(tx, c, { action: "transaction.recategorize", entity: "transaction", entityId: updated.length === 1 ? updated[0]! : null, before: rows.filter((r) => updated.includes(r.id)).map((r) => ({ id: r.id, categoryId: r.categoryId })), after: { ids: updated, categoryId } });
    await w.finish(minMonth(...dates));
    return { updated, skipped, total };
  });
}
