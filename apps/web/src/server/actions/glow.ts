"use server";
/**
 * Server actions for the simple bucket budget: categorize from the Transactions tab (with the
 * categorizer's learned-rule step), bucket goals, and reads the client pages fetch on demand.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { addToSavings, editTarget, listCategories, listTransactions, mergeCategories, recategorize, renameCategory, reorderCategories, savingsContributions, setBucketRollover, setSavingsBucket, setSavingsTarget, type TargetInput } from "@homebase/core";
import { recordCorrection, undoLearnedRule, type CategorizerRepo } from "@homebase/categorizer";
import { DbCategorizerRepo } from "@homebase/categorizer/db";
import { lastDayOfMonth } from "@homebase/shared";
import type { CategoryChoice, TxItem } from "@/lib/tx";
import { requireUser } from "../auth";
import { run, type ActionResult } from "../ctx";
import { getDb } from "../db";
import { log } from "../log";
import { loadCategoryChoices, loadTxPage, toTxItems, type TxQuery } from "../queries/glow";

const Id = z.string().uuid();
const Month = z.string().regex(/^\d{4}-\d{2}-01$/);

function touch() {
  revalidatePath("/", "layout");
}

export interface Learned {
  ruleId: string;
  /** "Learned: Lowe's → House Projects" */
  message: string;
  /** Other unapproved transactions from this payee the rule could apply to. */
  reapplyIds: string[];
}

/**
 * The categorizer's §9.5 learning step after a user categorization. Core already wrote the user
 * categorization event (with accepted = suggestion kept), so the repo's own event write is skipped.
 */
async function learnFrom(input: { transactionId: string; payeeName: string; fromCategoryId: string | null; toCategoryId: string; userId: string }): Promise<Learned | null> {
  try {
    const db = getDb();
    const repo = new DbCategorizerRepo(db);
    const noSave = new Proxy(repo, {
      get(target, key) {
        if (key === "saveEvent") return async () => {};
        const v = Reflect.get(target, key) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as CategorizerRepo;
    const names = await db.execute<{ id: string; name: string }>(sql`SELECT id, name FROM categories WHERE id = ${input.toCategoryId}`);
    const r = await recordCorrection(input, { repo: noSave, categoryName: (id) => names.rows.find((x) => x.id === id)?.name });
    if (!r.learnedRule || !r.toast) return null;
    return { ruleId: r.learnedRule.id, message: r.toast, reapplyIds: r.reapplyCandidateIds };
  } catch (e) {
    log.warn({ err: e instanceof Error ? e.message : String(e) }, "learned-rule step failed");
    return null;
  }
}

/**
 * Set a category on transactions and approve them. `suggested` is what the row offered (for learning);
 * returns what to restore for Undo, plus a learned rule when this was the second correction in a row.
 */
export async function categorizeAction(input: {
  ids: string[];
  categoryId: string;
  /** Per transaction: payee and the suggestion it showed, for the learned-rule step. */
  context?: { id: string; payee: string; suggested: string | null }[];
}): Promise<ActionResult<{ updated: string[]; skipped: { id: string; reason: string }[]; learned: Learned | null }>> {
  const i = z
    .object({
      ids: z.array(Id).min(1).max(500),
      categoryId: Id,
      context: z.array(z.object({ id: Id, payee: z.string().max(200), suggested: Id.nullable() })).max(500).optional(),
    })
    .parse(input);
  return run("categorize", async (ctx, cu) => {
    const r = await recategorize(ctx, i.ids, i.categoryId, { approve: true });
    let learned: Learned | null = null;
    // learn once per payee, from the first row that changed the suggestion
    const seen = new Set<string>();
    for (const c of i.context ?? []) {
      if (!r.updated.includes(c.id) || seen.has(c.payee) || !c.suggested || c.suggested === i.categoryId) continue;
      seen.add(c.payee);
      learned = (await learnFrom({ transactionId: c.id, payeeName: c.payee, fromCategoryId: c.suggested, toCategoryId: i.categoryId, userId: cu.user.id })) ?? learned;
    }
    touch();
    return { updated: r.updated, skipped: r.skipped, learned };
  });
}

/** Undo on the "Learned: …" toast: disable that learned rule. */
export async function disableLearnedRuleAction(ruleId: string): Promise<ActionResult> {
  const id = Id.parse(ruleId);
  return run("disable_learned_rule", async () => {
    await undoLearnedRule(new DbCategorizerRepo(getDb()), id);
    revalidatePath("/settings/rules");
    return {};
  });
}

/**
 * Give a bucket a plain monthly goal (or change / remove it). Simple goals keep their type (set aside,
 * refill, builder); anything else becomes "set aside $X each month" from this month on.
 */
export async function setBucketGoalAction(input: { categoryId: string; month: string; amount: bigint | null; keepType?: "need_set_aside" | "need_refill" | "monthly_builder" }): Promise<ActionResult<{ operationId: string | null }>> {
  const i = z
    .object({ categoryId: Id, month: Month, amount: z.bigint().positive().nullable(), keepType: z.enum(["need_set_aside", "need_refill", "monthly_builder"]).optional() })
    .parse(input);
  return run("bucket_goal", async (ctx) => {
    const target: TargetInput | null = i.amount === null ? null : { type: i.keepType ?? "need_set_aside", amount: i.amount, cadence: "monthly", cadenceEvery: 1 };
    const r = await editTarget(ctx, { categoryId: i.categoryId, month: i.month, target });
    touch();
    return { operationId: r.operationId };
  });
}

/**
 * Overflow (rollover) on or off for a bucket. Turning it on starts this month; `openingMilli` is what's
 * already saved (carried into the first month). Sent again while on, it only changes the opening amount.
 */
export async function setBucketRolloverAction(input: { categoryId: string; enabled: boolean; openingMilli?: bigint }): Promise<ActionResult<{ operationId: string | null }>> {
  const i = z.object({ categoryId: Id, enabled: z.boolean(), openingMilli: z.bigint().nonnegative().max(100_000_000_000n).optional() }).parse(input);
  return run("bucket_rollover", async (ctx) => {
    const r = await setBucketRollover(ctx, i.categoryId, { enabled: i.enabled, openingMilli: i.openingMilli });
    touch();
    return { operationId: r.operationId };
  });
}

const Money = z.bigint().min(-100_000_000_000n).max(100_000_000_000n);

/**
 * Savings bucket on or off (ADR "Buckets: savings buckets"). Turning it on starts this month; sent again
 * while on, it only changes what is given (that is how the starting balance is edited).
 */
export async function setSavingsBucketAction(input: { categoryId: string; enabled: boolean; openingMilli?: bigint; targetMilli?: bigint | null }): Promise<ActionResult<{ operationId: string | null }>> {
  const i = z.object({ categoryId: Id, enabled: z.boolean(), openingMilli: Money.nonnegative().optional(), targetMilli: Money.positive().nullable().optional() }).parse(input);
  return run("savings_bucket", async (ctx) => {
    const r = await setSavingsBucket(ctx, i.categoryId, { enabled: i.enabled, openingMilli: i.openingMilli, targetMilli: i.targetMilli });
    touch();
    return { operationId: r.operationId };
  });
}

/** Add money to a savings bucket (positive) or take it out (negative) in `month`. */
export async function addToSavingsAction(input: { categoryId: string; amount: bigint; month: string }): Promise<ActionResult<{ operationId: string | null }>> {
  const i = z.object({ categoryId: Id, amount: Money.refine((v) => v !== 0n), month: Month }).parse(input);
  return run("add_to_savings", async (ctx) => {
    const r = await addToSavings(ctx, i.categoryId, i.amount, i.month);
    touch();
    return { operationId: r.operationId };
  });
}

/** A savings bucket's target total (null clears it). */
export async function setSavingsTargetAction(input: { categoryId: string; targetMilli: bigint | null }): Promise<ActionResult<{ operationId: string | null }>> {
  const i = z.object({ categoryId: Id, targetMilli: Money.positive().nullable() }).parse(input);
  return run("savings_target", async (ctx) => {
    const r = await setSavingsTarget(ctx, i.categoryId, i.targetMilli);
    touch();
    return { operationId: r.operationId };
  });
}

export interface SavingsHistoryItem {
  operationId: string;
  at: string;
  amount: bigint;
  userName: string | null;
}

/** A savings bucket's adds and take-outs this month (newest first), for the sheet's history. */
export async function savingsHistoryAction(categoryId: string, month: string): Promise<SavingsHistoryItem[]> {
  await requireUser();
  const rows = await savingsContributions(getDb(), Id.parse(categoryId), Month.parse(month));
  return rows.map((r) => ({ operationId: r.operationId, at: r.at.toISOString(), amount: r.amount, userName: r.userName }));
}

/** A bucket's transactions for one month (the bucket sheet). */
export async function bucketTransactionsAction(categoryId: string, month: string): Promise<{ items: TxItem[]; choices: CategoryChoice[] }> {
  await requireUser();
  const id = Id.parse(categoryId);
  const m = Month.parse(month);
  const page = await listTransactions(getDb(), { categoryIds: [id], dateFrom: m, dateTo: lastDayOfMonth(m) }, { limit: 200, totals: false });
  const choices = await loadCategoryChoices();
  return { items: await toTxItems(page.rows, choices), choices };
}

/** More rows for the "All" list (cursor), or a fresh search. */
export async function loadTxPageAction(query: TxQuery, cursor: string | null): Promise<{ items: TxItem[]; nextCursor: string | null; total: number }> {
  await requireUser();
  const q = z
    .object({ mode: z.enum(["review", "all"]), accountId: Id.optional(), q: z.string().max(200).optional() })
    .parse(query);
  return loadTxPage(q, await loadCategoryChoices(), cursor === null ? null : z.string().max(400).parse(cursor));
}

// ── editing a bucket from its sheet ─────────────────────────────────────────

export interface BucketEditOptions {
  /** User groups in plan order. */
  groups: { id: string; name: string }[];
  /** Buckets this one could merge into, "Group · Name". */
  buckets: { id: string; label: string; groupId: string }[];
}

/** Groups and buckets for the sheet's Group and Merge pickers. */
export async function bucketEditOptionsAction(): Promise<BucketEditOptions> {
  await requireUser();
  const groups = (await listCategories(getDb(), { includeHidden: true })).filter((g) => !g.isSystem);
  return {
    groups: groups.map((g) => ({ id: g.id, name: g.name })),
    buckets: groups.flatMap((g) => g.categories.filter((c) => c.kind === "normal").map((c) => ({ id: c.id, label: `${g.name} · ${c.name}`, groupId: g.id }))),
  };
}

export async function renameBucketAction(input: { categoryId: string; name: string }): Promise<ActionResult<{ operationId: string | null }>> {
  const i = z.object({ categoryId: Id, name: z.string().trim().min(1, "Enter a name").max(100) }).parse(input);
  return run("rename_category", async (ctx) => {
    const r = await renameCategory(ctx, i.categoryId, i.name);
    touch();
    return { operationId: r.operationId };
  });
}

/** Move a bucket to the end of another group. */
export async function moveBucketAction(input: { categoryId: string; groupId: string }): Promise<ActionResult<{ operationId: string | null }>> {
  const i = z.object({ categoryId: Id, groupId: Id }).parse(input);
  return run("reorder_categories", async (ctx) => {
    const g = (await listCategories(ctx.db, { includeHidden: true })).find((x) => x.id === i.groupId);
    if (!g || g.isSystem) throw new Error("That group can't hold buckets");
    const r = await reorderCategories(ctx, { groupId: g.id, categoryIds: [...g.categories.map((c) => c.id).filter((id) => id !== i.categoryId), i.categoryId] });
    touch();
    return { operationId: r.operationId };
  });
}

/** Merge a bucket into another: its history moves over and it's removed (can't be undone). */
export async function mergeBucketAction(input: { sourceId: string; targetId: string }): Promise<ActionResult<{ transactions: number }>> {
  const i = z.object({ sourceId: Id, targetId: Id }).parse(input);
  return run("merge_categories", async (ctx) => {
    const r = await mergeCategories(ctx, { sourceId: i.sourceId, targetId: i.targetId });
    touch();
    return { transactions: r.transactions };
  });
}
