"use server";
/**
 * Plan (budget) server actions. Each mutation is one core operation (audited, undoable through
 * budget_operations) and revalidates the pages that show budget numbers.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  assign,
  autoAssign,
  categoryDetail,
  editTarget,
  moveMoney,
  redo,
  setMonthNote,
  setCategoryIcon,
  hideCategory,
  snoozeTarget,
  undo,
  unhideCategory,
  updateCategory,
  type TargetInput,
} from "@homebase/core";
import { AUTO_ASSIGN_MODES, type AutoAssignMode } from "@homebase/shared";
import { getDb } from "../db";
import { run, type ActionResult } from "../ctx";
import { requireUser } from "../auth";
import { today } from "@homebase/shared";
import type { TransactionVM } from "@/lib/view-models";
import { toTransactionVM } from "../queries/transactions";

const Month = z.string().regex(/^\d{4}-\d{2}-01$/);
const Id = z.string().uuid();

/** Every screen shows budget or account numbers (sidebar balances, Budget bars, Transactions badge). */
function touch() {
  revalidatePath("/", "layout");
}

export async function assignAction(input: { month: string; categoryId: string; amount: bigint }): Promise<ActionResult<{ operationId: string | null; rtaDelta: bigint }>> {
  const i = z.object({ month: Month, categoryId: Id, amount: z.bigint() }).parse(input);
  return run("assign", async (ctx) => {
    const r = await assign(ctx, i);
    touch();
    return { operationId: r.operationId, rtaDelta: r.rtaDelta };
  });
}

export async function moveMoneyAction(input: { month: string; from: string; to: string; amount: bigint }): Promise<ActionResult<{ operationId: string | null }>> {
  const i = z.object({ month: Month, from: z.union([Id, z.literal("rta")]), to: z.union([Id, z.literal("rta")]), amount: z.bigint().positive() }).parse(input);
  return run("move", async (ctx) => {
    const r = await moveMoney(ctx, i);
    touch();
    return { operationId: r.operationId };
  });
}

export async function autoAssignAction(input: { month: string; mode: string; categoryIds?: string[] }): Promise<ActionResult<{ operationId: string | null; total: bigint; count: number }>> {
  const i = z.object({ month: Month, mode: z.enum(AUTO_ASSIGN_MODES), categoryIds: z.array(Id).optional() }).parse(input);
  return run("auto_assign", async (ctx) => {
    const r = await autoAssign(ctx, { month: i.month, mode: i.mode as AutoAssignMode, categoryIds: i.categoryIds });
    touch();
    const total = r.changes.reduce((a, c) => a + (c.to - c.from), 0n);
    return { operationId: r.operationId, total, count: r.changes.length };
  });
}

export async function undoAction(operationId: string): Promise<ActionResult> {
  const id = Id.parse(operationId);
  return run("undo", async (ctx) => {
    await undo(ctx, id);
    touch();
    return {};
  });
}

export async function redoAction(operationId: string): Promise<ActionResult> {
  const id = Id.parse(operationId);
  return run("redo", async (ctx) => {
    await redo(ctx, id);
    touch();
    return {};
  });
}

export async function setMonthNoteAction(input: { month: string; categoryId?: string | null; note: string }): Promise<ActionResult<{ operationId: string | null }>> {
  const i = z.object({ month: Month, categoryId: Id.nullable().optional(), note: z.string().max(2000) }).parse(input);
  return run("month_note", async (ctx) => {
    const r = await setMonthNote(ctx, i);
    touch();
    return { operationId: r.operationId };
  });
}

export async function setCategoryNoteAction(input: { categoryId: string; note: string }): Promise<ActionResult<{ operationId: string | null }>> {
  const i = z.object({ categoryId: Id, note: z.string().max(2000) }).parse(input);
  return run("category_note", async (ctx) => {
    const r = await updateCategory(ctx, i.categoryId, { note: i.note });
    touch();
    return { operationId: r.operationId };
  });
}

export async function editTargetAction(input: { categoryId: string; month: string; target: TargetInput | null }): Promise<ActionResult<{ operationId: string | null }>> {
  const i = z.object({ categoryId: Id, month: Month }).parse(input);
  return run("edit_target", async (ctx) => {
    const r = await editTarget(ctx, { categoryId: i.categoryId, month: i.month, target: input.target });
    touch();
    return { operationId: r.operationId };
  });
}

export async function snoozeTargetAction(input: { categoryId: string; month: string; snoozed: boolean }): Promise<ActionResult<{ operationId: string | null }>> {
  const i = z.object({ categoryId: Id, month: Month, snoozed: z.boolean() }).parse(input);
  return run("snooze_target", async (ctx) => {
    const r = await snoozeTarget(ctx, i);
    touch();
    return { operationId: r.operationId };
  });
}

export interface CategoryDetailVM {
  groupName: string;
  breakdown: { leftOverFromLastMonth: bigint; assigned: bigint; cashSpending: bigint; creditSpending: bigint; otherActivity: bigint; available: bigint };
  history: { month: string; assigned: bigint; activity: bigint; available: bigint }[];
  recent: TransactionVM[];
}

/** Read for the category sheet (opened client-side). */
export async function categoryDetailAction(month: string, categoryId: string): Promise<CategoryDetailVM | null> {
  await requireUser();
  const m = Month.parse(month);
  const id = Id.parse(categoryId);
  try {
    const d = await categoryDetail(getDb(), m, id, { today: today(), limit: 8 });
    return { groupName: d.groupName, breakdown: d.breakdown, history: d.history, recent: d.recentTransactions.map(toTransactionVM) };
  } catch {
    return null;
  }
}


export async function setCategoryHiddenAction(input: { categoryId: string; hidden: boolean }): Promise<ActionResult<{ operationId: string | null }>> {
  const i = z.object({ categoryId: Id, hidden: z.boolean() }).parse(input);
  return run("hide_category", async (ctx) => {
    const r = i.hidden ? await hideCategory(ctx, i.categoryId) : await unhideCategory(ctx, i.categoryId);
    touch();
    return { operationId: r.operationId };
  });
}

/** Set (or clear → suggested from the name) a category's lucide icon. Undoable like other category edits. */
export async function setCategoryIconAction(input: { categoryId: string; icon: string | null }): Promise<ActionResult<{ operationId: string | null }>> {
  const i = z.object({ categoryId: Id, icon: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64).nullable() }).parse(input);
  return run("set_category_icon", async (ctx) => {
    const r = await setCategoryIcon(ctx, i.categoryId, i.icon);
    touch();
    revalidatePath("/settings/categories");
    return { operationId: r.operationId };
  });
}
