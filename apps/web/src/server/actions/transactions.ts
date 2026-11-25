"use server";
/** Activity (transactions) server actions: review inbox, register edits, manual entry, reconcile. */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  approveAllHighConfidence,
  approveTransactions,
  createScheduled,
  createTransaction,
  deleteScheduled,
  deleteTransactions,
  markTransfer,
  reconcile,
  recategorize,
  splitTransaction,
  unapproveTransactions,
  updateScheduled,
  updateTransaction,
} from "@homebase/core";
import { CLEARED, FLAGS, FREQUENCIES } from "@homebase/shared";
import { run, type ActionResult } from "../ctx";
import { requireUser } from "../auth";
import { loadRegister, type RegisterQuery } from "../queries/transactions";
import type { TransactionVM } from "@/lib/view-models";

const Id = z.string().uuid();
const Ids = z.array(Id).min(1).max(500);

/** Every screen shows budget or account numbers (sidebar balances, Budget bars, Transactions badge). */
function touch() {
  revalidatePath("/", "layout");
}

export async function approveAction(ids: string[]): Promise<ActionResult<{ approved: string[] }>> {
  const v = Ids.parse(ids);
  return run("approve", async (ctx) => {
    const r = await approveTransactions(ctx, v);
    touch();
    return { approved: r.approved };
  });
}

export async function unapproveAction(ids: string[]): Promise<ActionResult> {
  const v = Ids.parse(ids);
  return run("unapprove", async (ctx) => {
    await unapproveTransactions(ctx, v);
    touch();
    return {};
  });
}

export async function approveAllHighConfidenceAction(): Promise<ActionResult<{ approved: string[] }>> {
  return run("approve_all_high", async (ctx) => {
    const r = await approveAllHighConfidence(ctx);
    touch();
    return { approved: r.approved };
  });
}

/** Set the category (and approve). Returns what to restore for Undo. */
export async function recategorizeAction(input: { ids: string[]; categoryId: string | null; approve?: boolean }): Promise<ActionResult<{ updated: string[]; skipped: { id: string; reason: string }[] }>> {
  const i = z.object({ ids: Ids, categoryId: Id.nullable(), approve: z.boolean().optional() }).parse(input);
  return run("recategorize", async (ctx) => {
    const r = await recategorize(ctx, i.ids, i.categoryId, { approve: i.approve ?? true });
    touch();
    return { updated: r.updated, skipped: r.skipped };
  });
}

/** Undo for recategorize/split: put each row back to its previous category and approval. */
export async function restoreTransactionsAction(rows: { id: string; categoryId: string | null; approved: boolean }[]): Promise<ActionResult> {
  const v = z.array(z.object({ id: Id, categoryId: Id.nullable(), approved: z.boolean() })).min(1).max(500).parse(rows);
  return run("restore", async (ctx) => {
    for (const r of v) await updateTransaction(ctx, r.id, { categoryId: r.categoryId, approved: r.approved });
    touch();
    return {};
  });
}

export async function splitAction(input: { id: string; lines: { categoryId: string | null; amount: bigint; memo?: string }[]; approve?: boolean }): Promise<ActionResult> {
  const i = z
    .object({ id: Id, lines: z.array(z.object({ categoryId: Id.nullable(), amount: z.bigint(), memo: z.string().max(500).optional() })).min(2), approve: z.boolean().optional() })
    .parse(input);
  return run("split", async (ctx) => {
    await splitTransaction(ctx, i.id, i.lines.map((l) => ({ categoryId: l.categoryId, amount: l.amount, memo: l.memo ?? null })));
    if (i.approve) await approveTransactions(ctx, [i.id]);
    touch();
    return {};
  });
}

export async function markTransferAction(input: { id: string; accountId: string; pairWithId?: string | null }): Promise<ActionResult<{ pairId: string }>> {
  const i = z.object({ id: Id, accountId: Id, pairWithId: Id.nullable().optional() }).parse(input);
  return run("mark_transfer", async (ctx) => {
    const r = await markTransfer(ctx, i.id, { accountId: i.accountId, pairWithId: i.pairWithId ?? null });
    await approveTransactions(ctx, [i.id, r.pair.id]);
    touch();
    return { pairId: r.pair.id };
  });
}

export async function setClearedAction(input: { id: string; cleared: (typeof CLEARED)[number] }): Promise<ActionResult> {
  const i = z.object({ id: Id, cleared: z.enum(["cleared", "uncleared"]) }).parse(input);
  return run("set_cleared", async (ctx) => {
    await updateTransaction(ctx, i.id, { cleared: i.cleared });
    touch();
    return {};
  });
}

const NewTx = z.object({
  accountId: Id,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.bigint().refine((v) => v !== 0n, "amount can't be zero"),
  payeeName: z.string().trim().max(200).optional(),
  categoryId: Id.nullable().optional(),
  memo: z.string().max(500).optional(),
  cleared: z.enum(["cleared", "uncleared"]).default("uncleared"),
  splits: z.array(z.object({ categoryId: Id.nullable(), amount: z.bigint(), memo: z.string().max(500).optional() })).optional(),
  transferAccountId: Id.nullable().optional(),
  flag: z.enum(FLAGS).nullable().optional(),
});

export async function createTransactionAction(input: z.input<typeof NewTx>): Promise<ActionResult<{ id: string }>> {
  const i = NewTx.parse(input);
  return run("create_transaction", async (ctx) => {
    const t = await createTransaction(ctx, {
      accountId: i.accountId,
      date: i.date,
      amount: i.amount,
      payeeName: i.payeeName || null,
      categoryId: i.splits?.length ? null : (i.categoryId ?? null),
      memo: i.memo || null,
      cleared: i.cleared,
      approved: true,
      splits: i.splits?.length ? i.splits.map((s) => ({ categoryId: s.categoryId, amount: s.amount, memo: s.memo ?? null })) : undefined,
      transferAccountId: i.transferAccountId ?? null,
      flag: i.flag ?? null,
    });
    touch();
    return { id: t.id };
  });
}

export async function deleteTransactionsAction(ids: string[]): Promise<ActionResult> {
  const v = Ids.parse(ids);
  return run("delete_transactions", async (ctx) => {
    await deleteTransactions(ctx, v);
    touch();
    return {};
  });
}

export async function reconcileAction(input: { accountId: string; statementBalance: bigint }): Promise<ActionResult<{ difference: bigint; reconciledCount: number; adjustmentId: string | null }>> {
  const i = z.object({ accountId: Id, statementBalance: z.bigint() }).parse(input);
  return run("reconcile", async (ctx) => {
    const r = await reconcile(ctx, i);
    touch();
    return { difference: r.difference, reconciledCount: r.reconciledCount, adjustmentId: r.adjustment?.id ?? null };
  });
}

/** Register pagination (cursor) — a read. */
export async function loadMoreTransactionsAction(q: RegisterQuery, cursor: string): Promise<{ rows: TransactionVM[]; nextCursor: string | null }> {
  await requireUser();
  const query = z
    .object({
      accountId: Id.optional(),
      q: z.string().max(200).optional(),
      filter: z.enum(["all", "uncleared", "unapproved"]).optional(),
      categoryIds: z.array(Id).max(50).optional(),
      payeeIds: z.array(Id).max(50).optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    .parse(q);
  const r = await loadRegister(query, z.string().max(200).parse(cursor));
  return { rows: r.rows, nextCursor: r.nextCursor };
}

const Patch = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  amount: z.bigint().optional(),
  payeeName: z.string().trim().max(200).nullable().optional(),
  categoryId: Id.nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
  cleared: z.enum(["cleared", "uncleared"]).optional(),
  approved: z.boolean().optional(),
  flag: z.enum(FLAGS).nullable().optional(),
});

export async function updateTransactionAction(id: string, patch: z.input<typeof Patch>): Promise<ActionResult> {
  const tid = Id.parse(id);
  const p = Patch.parse(patch);
  return run("update_transaction", async (ctx) => {
    await updateTransaction(ctx, tid, p);
    touch();
    return {};
  });
}

const ScheduledIn = z.object({
  accountId: Id,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  frequency: z.enum(FREQUENCIES),
  amount: z.bigint().refine((v) => v !== 0n, "amount can't be zero"),
  payeeName: z.string().trim().max(200).nullable().optional(),
  categoryId: Id.nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
  flag: z.enum(FLAGS).nullable().optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  splits: z.array(z.object({ categoryId: Id.nullable(), amount: z.bigint(), memo: z.string().max(500).nullable().optional() })).optional(),
});

/** Scheduled transactions (§6.8): create, edit (from this occurrence on) and delete. */
export async function saveScheduledAction(id: string | null, input: z.input<typeof ScheduledIn>): Promise<ActionResult<{ id: string }>> {
  const i = ScheduledIn.parse(input);
  const sid = id === null ? null : Id.parse(id);
  return run("save_scheduled", async (ctx) => {
    const body = { ...i, splits: i.splits?.length ? i.splits : undefined, categoryId: i.splits?.length ? null : (i.categoryId ?? null) };
    const s = sid ? await updateScheduled(ctx, sid, body) : await createScheduled(ctx, body);
    touch();
    return { id: s.id };
  });
}

export async function deleteScheduledAction(id: string): Promise<ActionResult> {
  const sid = Id.parse(id);
  return run("delete_scheduled", async (ctx) => {
    await deleteScheduled(ctx, sid);
    touch();
    return {};
  });
}
