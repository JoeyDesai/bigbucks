/**
 * Budget operations (spec §6.6, §6.8, §12.1): assign, move money, auto-assign, undo/redo, Recent Moves,
 * month notes, targets, and category/group edits. Every operation is one transaction that
 *   1. writes `budget_operations` (payload + inverse, so it can be undone/redone),
 *   2. writes `audit_log` (actor user|ai|system, confirmed_by for AI),
 *   3. recomputes the engine cache from the earliest affected month.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lte, max, sql } from "drizzle-orm";
import { z } from "zod";
import {
  budgetOperations,
  categories,
  categoryGroups,
  monthAssignments,
  monthNotes,
  payees,
  scheduledTransactionSplits,
  scheduledTransactions,
  targets,
  transactionSplits,
  transactions,
  users,
  type BudgetOperation,
  type Tx,
} from "@homebase/db";
import {
  AUTO_ASSIGN_MODES,
  CADENCES,
  TARGET_TYPES,
  formatMilli,
  isIconKey,
  monthOf,
  suggestCategoryIcon,
  newId,
  type AutoAssignMode,
  type Milli,
  type Month,
} from "@homebase/shared";
import {
  RTA,
  assign as engineAssign,
  assignExpression,
  autoAssign as engineAutoAssign,
  invertChanges,
  moveMoney as engineMoveMoney,
  rtaDelta,
  type AssignmentChange,
} from "@homebase/engine";
import { writeAudit } from "../audit";
import { savingsChangeError } from "../buckets/math";
import { savingsMonths, savingsSettings } from "../buckets/savings";
import { ctxToday, withTx, type Ctx, type DbLike } from "../context";
import { ConflictError, NotFoundError, ValidationError, assertFound } from "../errors";
import { toJson } from "../json";
import { beginBudgetWrite, runEngine, throughMonth, type BudgetWrite } from "./cache";
import { applyRowChanges, invertRowChanges, trackRow, type RowChange } from "./rowChanges";
import { loadSnapshot } from "./snapshot";

// ── shared plumbing ─────────────────────────────────────────────────────────

type OpKind = BudgetOperation["kind"];

interface SerializedChange {
  month: Month;
  categoryId: string;
  from: string;
  to: string;
}

/** budget_operations.payload / inverse shape (v1). Seeded/legacy rows without `changes`/`rows` can't be undone. */
export interface OperationPayload {
  v: 1;
  action: string;
  args?: unknown;
  changes?: SerializedChange[];
  rows?: RowChange[];
}

const serChanges = (cs: readonly AssignmentChange[]): SerializedChange[] => cs.map((c) => ({ month: c.month, categoryId: c.categoryId, from: c.from.toString(), to: c.to.toString() }));
const deserChanges = (cs: readonly SerializedChange[] | undefined): AssignmentChange[] =>
  (cs ?? []).map((c) => ({ month: c.month, categoryId: c.categoryId, from: BigInt(c.from), to: BigInt(c.to) }));

export interface OperationResult {
  operationId: string | null;
  changes: AssignmentChange[];
  /** Effect on Ready to Assign (this month and later). */
  rtaDelta: Milli;
  /** First month whose cache rows were rewritten. */
  recomputedFrom: Month | null;
}

const MonthSchema = z.string().regex(/^\d{4}-\d{2}-01$/, "month must be YYYY-MM-01");

async function currentAssigned(tx: DbLike, month: Month, categoryId: string): Promise<Milli> {
  const rows = await tx
    .select({ a: monthAssignments.assignedMilli })
    .from(monthAssignments)
    .where(and(eq(monthAssignments.month, month), eq(monthAssignments.categoryId, categoryId)))
    .for("update");
  return rows[0]?.a ?? 0n;
}

/** Write assignment changes; each cell must currently hold `from` (else ConflictError). */
export async function applyAssignmentChanges(tx: DbLike, changes: readonly AssignmentChange[]): Promise<void> {
  for (const c of changes) {
    const cur = await currentAssigned(tx, c.month, c.categoryId);
    if (cur !== c.from) throw new ConflictError(`assigned for ${c.categoryId} in ${c.month} changed (expected ${formatMilli(c.from)}, found ${formatMilli(cur)})`);
    if (c.to === 0n) {
      await tx.delete(monthAssignments).where(and(eq(monthAssignments.month, c.month), eq(monthAssignments.categoryId, c.categoryId)));
    } else {
      await tx
        .insert(monthAssignments)
        .values({ month: c.month, categoryId: c.categoryId, assignedMilli: c.to })
        .onConflictDoUpdate({ target: [monthAssignments.month, monthAssignments.categoryId], set: { assignedMilli: c.to, updatedAt: new Date() } });
    }
  }
}

const minMonthOf = (changes: readonly AssignmentChange[]): Month | null => changes.reduce<Month | null>((m, c) => (m === null || c.month < m ? c.month : m), null);

async function recordOperation(
  tx: Tx,
  ctx: Ctx,
  o: { kind: OpKind; month: Month | null; action: string; args?: unknown; changes?: AssignmentChange[]; rows?: RowChange[]; entity: string; entityId: string | null; irreversible?: boolean },
): Promise<string> {
  const payload: OperationPayload = { v: 1, action: o.action, args: toJson(o.args ?? null) };
  const inverse: OperationPayload = { v: 1, action: `undo:${o.action}` };
  if (!o.irreversible) {
    if (o.changes?.length) {
      payload.changes = serChanges(o.changes);
      inverse.changes = serChanges(invertChanges(o.changes));
    }
    if (o.rows?.length) {
      payload.rows = o.rows;
      inverse.rows = invertRowChanges(o.rows);
    }
  }
  const [op] = await tx
    .insert(budgetOperations)
    .values({ userId: ctx.userId, kind: o.kind, month: o.month, payload: payload as never, inverse: inverse as never })
    .returning({ id: budgetOperations.id });
  await writeAudit(tx, ctx, {
    action: `budget.${o.action}`,
    entity: o.entity,
    entityId: o.entityId,
    before: o.changes?.length ? { changes: serChanges(o.changes).map(({ month, categoryId, from }) => ({ month, categoryId, assigned_milli: from })) } : o.rows?.map((r) => r.before),
    after: o.changes?.length ? { operation_id: op!.id, changes: serChanges(o.changes).map(({ month, categoryId, to }) => ({ month, categoryId, assigned_milli: to })) } : { operation_id: op!.id, rows: o.rows?.map((r) => r.after), args: o.args },
  });
  return op!.id;
}

async function assignableCategory(tx: DbLike, categoryId: string): Promise<typeof categories.$inferSelect> {
  const [c] = await tx.select().from(categories).where(eq(categories.id, categoryId));
  if (!c) throw new NotFoundError("category", categoryId);
  if (c.deletedAt) throw new ValidationError(`category ${c.name} is deleted`);
  if (c.kind !== "normal" && c.kind !== "cc_payment") throw new ValidationError(`can't assign to ${c.name}`);
  return c;
}

/** Apply assignment changes as one operation (the common tail of assign/move/auto-assign). */
async function commitChanges(tx: Tx, ctx: Ctx, w: BudgetWrite, o: { kind: OpKind; month: Month; action: string; args: unknown; changes: AssignmentChange[]; entity: string; entityId: string | null }): Promise<OperationResult> {
  if (o.changes.length === 0) {
    await w.finish(null);
    return { operationId: null, changes: [], rtaDelta: 0n, recomputedFrom: null };
  }
  await applyAssignmentChanges(tx, o.changes);
  const operationId = await recordOperation(tx, ctx, o);
  const from = minMonthOf(o.changes);
  const r = await w.finish(from);
  return { operationId, changes: o.changes, rtaDelta: rtaDelta(o.changes), recomputedFrom: r.writtenFrom };
}

// ── assign / move ───────────────────────────────────────────────────────────

export interface AssignInput {
  month: Month;
  categoryId: string;
  /** New Assigned value. */
  amount?: Milli;
  /** Or the Assigned-cell mini-language: "+50", "=200", "*2", "-25". */
  expr?: string;
}

/** Set Assigned(category, month) (spec §12.1: accepts math like `+50` or `=200`). */
export async function assign(ctx: Ctx, input: AssignInput): Promise<OperationResult> {
  MonthSchema.parse(input.month);
  if (input.amount === undefined && input.expr === undefined) throw new ValidationError("assign needs amount or expr");
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    await assignableCategory(tx, input.categoryId);
    const cur = await currentAssigned(tx, input.month, input.categoryId);
    const src = () => cur;
    let changes: AssignmentChange[];
    try {
      changes =
        input.expr !== undefined
          ? assignExpression(src, { month: input.month, categoryId: input.categoryId, expr: input.expr })
          : engineAssign(src, { month: input.month, categoryId: input.categoryId, to: input.amount! });
    } catch (e) {
      throw new ValidationError(e instanceof Error ? e.message : String(e));
    }
    return commitChanges(tx, c, w, { kind: "assign", month: input.month, action: "assign", args: input, changes, entity: "category", entityId: input.categoryId });
  });
}

export interface MoveMoneyInput {
  month: Month;
  /** Category id or "rta". */
  from: string;
  to: string;
  amount: Milli;
}

/** Move money category↔category or category↔Ready to Assign, as one undoable operation (§6.8). */
export async function moveMoney(ctx: Ctx, input: MoveMoneyInput): Promise<OperationResult> {
  MonthSchema.parse(input.month);
  if (input.amount <= 0n) throw new ValidationError("amount must be positive");
  if (input.from === input.to) throw new ValidationError("from and to must differ");
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    const cells = new Map<string, Milli>();
    for (const id of [input.from, input.to]) {
      if (id === RTA) continue;
      await assignableCategory(tx, id);
      cells.set(id, await currentAssigned(tx, input.month, id));
    }
    const changes = engineMoveMoney((_m, cid) => cells.get(cid) ?? 0n, input);
    return commitChanges(tx, c, w, {
      kind: "move",
      month: input.month,
      action: "move",
      args: input,
      changes,
      entity: "category",
      entityId: input.to === RTA ? input.from : input.to,
    });
  });
}

export interface AutoAssignInput {
  month: Month;
  mode: AutoAssignMode;
  /** Selected categories; empty/undefined = all visible categories. */
  categoryIds?: string[];
  order?: "spec" | "ynab";
}

/** Auto-Assign (§6.6) as a single undoable operation. */
export async function autoAssign(ctx: Ctx, input: AutoAssignInput): Promise<OperationResult> {
  MonthSchema.parse(input.month);
  if (!AUTO_ASSIGN_MODES.includes(input.mode)) throw new ValidationError(`unknown auto-assign mode ${input.mode}`);
  return withTx(ctx, async (tx, c) => {
    const today = ctxToday(c);
    const w = await beginBudgetWrite(tx, today);
    const snapshot = await loadSnapshot(tx);
    const t = throughMonth(snapshot, today);
    const through = t > input.month ? t : input.month;
    const result = runEngine(snapshot, today, through);
    const changes = engineAutoAssign(
      snapshot,
      { month: input.month, mode: input.mode, selection: input.categoryIds, order: input.order, budget: { through, asOf: today } },
      result,
    );
    return commitChanges(tx, c, w, { kind: "auto_assign", month: input.month, action: "auto_assign", args: input, changes, entity: "month", entityId: input.month });
  });
}

// ── undo / redo ─────────────────────────────────────────────────────────────

function rowsMonth(rows: readonly RowChange[] | undefined): Month | null {
  let m: Month | null = null;
  for (const r of rows ?? []) {
    if (r.table !== "targets") continue;
    const ef = r.pk.effective_from;
    if (ef && (m === null || ef < m)) m = ef;
  }
  return m;
}

async function replay(ctx: Ctx, operationId: string, direction: "undo" | "redo"): Promise<OperationResult> {
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    const [op] = await tx.select().from(budgetOperations).where(eq(budgetOperations.id, operationId)).for("update");
    if (!op) throw new NotFoundError("budget operation", operationId);
    if (direction === "undo" && op.undoneAt) throw new ConflictError("operation is already undone");
    if (direction === "redo" && !op.undoneAt) throw new ConflictError("operation is not undone");
    const p = (direction === "undo" ? op.inverse : op.payload) as OperationPayload;
    if (!p || p.v !== 1 || (!p.changes?.length && !p.rows?.length)) throw new ValidationError("this operation can't be undone");
    const changes = deserChanges(p.changes);
    await applyAssignmentChanges(tx, changes);
    if (p.rows?.length) await applyRowChanges(tx, p.rows);
    await tx
      .update(budgetOperations)
      .set({ undoneAt: direction === "undo" ? new Date() : null })
      .where(eq(budgetOperations.id, op.id));
    await writeAudit(tx, c, {
      action: `budget.${direction}`,
      entity: "budget_operation",
      entityId: op.id,
      before: { kind: op.kind, undone: direction === "redo" },
      after: { kind: op.kind, undone: direction === "undo", changes: p.changes, rows: p.rows?.map((r) => ({ table: r.table, pk: r.pk })) },
    });
    const a = minMonthOf(changes);
    const b = rowsMonth(p.rows);
    const from = a === null ? b : b === null ? a : a < b ? a : b;
    const r = await w.finish(from);
    return { operationId: op.id, changes, rtaDelta: rtaDelta(changes), recomputedFrom: r.writtenFrom };
  });
}

/** Undo an operation. Fails with ConflictError if any cell/row it touched changed since. */
export const undo = (ctx: Ctx, operationId: string) => replay(ctx, operationId, "undo");
/** Redo an undone operation. */
export const redo = (ctx: Ctx, operationId: string) => replay(ctx, operationId, "redo");

// ── Recent Moves ────────────────────────────────────────────────────────────

export interface RecentMove {
  id: string;
  at: Date;
  kind: OpKind;
  month: Month | null;
  userId: string | null;
  userName: string | null;
  description: string;
  undone: boolean;
  canUndo: boolean;
  canRedo: boolean;
  changes: AssignmentChange[];
}

const AUTO_ASSIGN_LABEL: Record<AutoAssignMode, string> = {
  underfunded: "Underfunded",
  assigned_last_month: "Assigned last month",
  spent_last_month: "Spent last month",
  average_assigned: "Average assigned",
  average_spent: "Average spent",
  reduce_overfunding: "Reduce overfunding",
  reset_available: "Reset available amounts",
  reset_assigned: "Reset assigned amounts",
};

function describe(op: BudgetOperation, names: Map<string, string>): string {
  const p = op.payload as OperationPayload & Record<string, unknown>;
  const name = (id: unknown) => (id === RTA ? "Ready to Assign" : (names.get(String(id)) ?? "a category"));
  const args = (p.args ?? {}) as Record<string, unknown>;
  const changes = deserChanges(p.changes);
  switch (op.kind) {
    case "move": {
      const amount = args.amount ?? p.amount_milli;
      const from = args.from ?? p.from;
      const to = args.to ?? p.to;
      return `Moved ${amount !== undefined ? formatMilli(BigInt(String(amount))) : "money"} from ${name(from)} to ${name(to)}`;
    }
    case "assign": {
      const ch = changes[0];
      return ch ? `Assigned ${formatMilli(ch.to)} to ${name(ch.categoryId)} (was ${formatMilli(ch.from)})` : `Assigned to ${name(args.categoryId)}`;
    }
    case "auto_assign": {
      const mode = (args.mode ?? p.mode) as AutoAssignMode | undefined;
      const total = changes.reduce((s, c) => s + (c.to - c.from), 0n);
      const label = mode ? (AUTO_ASSIGN_LABEL[mode] ?? mode) : "Auto-Assign";
      return changes.length ? `Auto-Assign: ${label} (${changes.length} categor${changes.length === 1 ? "y" : "ies"}, ${formatMilli(total, { sign: "always" })})` : `Auto-Assign: ${label}`;
    }
    case "target_edit":
      return `${p.action === "snooze_target" ? "Snoozed/unsnoozed target" : "Edited target"} for ${name(args.categoryId)}`;
    case "note_edit":
      return args.categoryId ? `Edited note for ${name(args.categoryId)}` : "Edited month note";
    case "category_edit":
    case "group_edit":
      return `${String(p.action ?? op.kind).replace(/_/g, " ")}${args.name ? `: ${String(args.name)}` : ""}`;
    default:
      return String(p.action ?? op.kind);
  }
}

/** The "Recent Moves" list for a month, newest first (§6.6, §12.1). */
export async function listRecentMoves(db: DbLike, month: Month, opts: { limit?: number; kinds?: OpKind[] } = {}): Promise<RecentMove[]> {
  const kinds = opts.kinds ?? (["assign", "move", "auto_assign", "reset"] as OpKind[]);
  const rows = await db
    .select({ op: budgetOperations, userName: users.displayName })
    .from(budgetOperations)
    .leftJoin(users, eq(users.id, budgetOperations.userId))
    .where(and(eq(budgetOperations.month, month), inArray(budgetOperations.kind, kinds)))
    .orderBy(desc(budgetOperations.at), desc(budgetOperations.id))
    .limit(Math.min(opts.limit ?? 50, 500));
  const names = new Map((await db.select({ id: categories.id, name: categories.name }).from(categories)).map((c) => [c.id, c.name]));
  return rows.map(({ op, userName }) => {
    const p = op.payload as OperationPayload;
    const inv = op.inverse as OperationPayload;
    const undoable = !!(p?.v === 1 && (p.changes?.length || p.rows?.length));
    return {
      id: op.id,
      at: op.at,
      kind: op.kind,
      month: op.month,
      userId: op.userId,
      userName,
      description: describe(op, names),
      undone: !!op.undoneAt,
      canUndo: undoable && !op.undoneAt && !!(inv?.changes?.length || inv?.rows?.length),
      canRedo: undoable && !!op.undoneAt,
      changes: deserChanges(p?.changes),
    };
  });
}

// ── month notes ─────────────────────────────────────────────────────────────

/** Set (or clear, with an empty note) the month note or a category's note for a month. Undoable. */
export async function setMonthNote(ctx: Ctx, input: { month: Month; categoryId?: string | null; note: string }): Promise<OperationResult> {
  MonthSchema.parse(input.month);
  const categoryId = input.categoryId ?? null;
  const note = input.note.trim();
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    if (categoryId) assertFound((await tx.select({ id: categories.id }).from(categories).where(eq(categories.id, categoryId)))[0], "category", categoryId);
    const [existing] = await tx
      .select()
      .from(monthNotes)
      .where(and(eq(monthNotes.month, input.month), categoryId ? eq(monthNotes.categoryId, categoryId) : isNull(monthNotes.categoryId)));
    if (!existing && note === "") {
      await w.finish(null);
      return { operationId: null, changes: [], rtaDelta: 0n, recomputedFrom: null };
    }
    const id = existing?.id ?? newId();
    const row = await trackRow(tx, "month_notes", { id }, async () => {
      if (note === "") await tx.delete(monthNotes).where(eq(monthNotes.id, id));
      else if (existing) await tx.update(monthNotes).set({ note }).where(eq(monthNotes.id, id));
      else await tx.insert(monthNotes).values({ id, month: input.month, categoryId, note });
    });
    const operationId = await recordOperation(tx, c, { kind: "note_edit", month: input.month, action: "note", args: { categoryId, note }, rows: [row], entity: categoryId ? "category" : "month", entityId: categoryId ?? input.month });
    await w.finish(null);
    return { operationId, changes: [], rtaDelta: 0n, recomputedFrom: null };
  });
}

export async function getMonthNotes(db: DbLike, month: Month): Promise<{ month: string | null; categories: Record<string, string> }> {
  const rows = await db.select().from(monthNotes).where(eq(monthNotes.month, month));
  const out = { month: null as string | null, categories: {} as Record<string, string> };
  for (const r of rows) {
    if (r.categoryId) out.categories[r.categoryId] = r.note;
    else out.month = r.note;
  }
  return out;
}

// ── targets ─────────────────────────────────────────────────────────────────

const milli = z.union([z.bigint(), z.string().regex(/^-?\d+$/).transform((s) => BigInt(s)), z.number().int().transform((n) => BigInt(n))]);

export const TargetInputSchema = z
  .object({
    type: z.enum(TARGET_TYPES),
    amount: milli.default(0n),
    cadence: z.enum(CADENCES).default("monthly"),
    cadenceEvery: z.number().int().min(1).max(120).default(1),
    day: z.number().int().min(0).max(31).nullable().default(null),
    targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    percent: z.union([z.string().regex(/^\d+(\.\d+)?$/), z.number().min(0).max(100).transform((n) => String(n))]).nullable().default(null),
    incomeBasis: z.enum(["rta_inflows", "gross_pay"]).nullable().default(null),
  })
  .superRefine((t, c) => {
    if (t.type === "percent_of_income" && t.percent === null) c.addIssue({ code: "custom", message: "percent_of_income needs percent" });
    if (t.type === "balance_by_date" && !t.targetDate) c.addIssue({ code: "custom", message: "balance_by_date needs targetDate" });
    if (t.type !== "percent_of_income" && t.amount < 0n) c.addIssue({ code: "custom", message: "amount must be ≥ 0" });
  });
export type TargetInput = z.input<typeof TargetInputSchema>;

async function effectiveTargetRow(tx: DbLike, categoryId: string, month: Month) {
  const [row] = await tx
    .select()
    .from(targets)
    .where(and(eq(targets.categoryId, categoryId), lte(targets.effectiveFrom, month)))
    .orderBy(desc(targets.effectiveFrom))
    .limit(1);
  return row && !row.removed ? row : null;
}

/**
 * Create/replace/remove a category's target from `month` (default: current month) forward (§6.5):
 * writes a new `effective_from` row so earlier months keep the target that applied then. Rows effective
 * after `month` are dropped so the edit really applies "from here on". `target: null` removes it.
 */
export async function editTarget(ctx: Ctx, input: { categoryId: string; target: TargetInput | null; month?: Month }): Promise<OperationResult> {
  const month = input.month ?? monthOf(ctxToday(ctx));
  MonthSchema.parse(month);
  const t = input.target === null ? null : TargetInputSchema.parse(input.target);
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    const cat = assertFound((await tx.select().from(categories).where(eq(categories.id, input.categoryId)))[0], "category", input.categoryId);
    if (cat.kind !== "normal" && cat.kind !== "cc_payment") throw new ValidationError(`${cat.name} can't have a target`);
    const rows: RowChange[] = [];
    const later = await tx.select({ ef: targets.effectiveFrom }).from(targets).where(and(eq(targets.categoryId, cat.id), gt(targets.effectiveFrom, month)));
    for (const l of later) {
      rows.push(await trackRow(tx, "targets", { category_id: cat.id, effective_from: l.ef }, () => tx.delete(targets).where(and(eq(targets.categoryId, cat.id), eq(targets.effectiveFrom, l.ef)))));
    }
    const prev = await effectiveTargetRow(tx, cat.id, month);
    if (t === null && !prev) throw new ValidationError(`${cat.name} has no target to remove`);
    const values = t
      ? {
          type: t.type,
          amountMilli: t.amount,
          cadence: t.cadence,
          cadenceEvery: t.cadenceEvery,
          day: t.day,
          targetDate: t.targetDate,
          percent: t.percent,
          incomeBasis: t.incomeBasis,
          snoozedMonth: null,
          removed: false,
        }
      : { type: prev!.type, amountMilli: 0n, cadence: prev!.cadence, cadenceEvery: 1, day: null, targetDate: null, percent: null, incomeBasis: null, snoozedMonth: null, removed: true };
    const createdMonth = prev && t && prev.type === t.type ? prev.createdMonth : month;
    rows.push(
      await trackRow(tx, "targets", { category_id: cat.id, effective_from: month }, () =>
        tx
          .insert(targets)
          .values({ categoryId: cat.id, effectiveFrom: month, createdMonth, ...values })
          .onConflictDoUpdate({ target: [targets.categoryId, targets.effectiveFrom], set: { ...values, updatedAt: new Date() } }),
      ),
    );
    const operationId = await recordOperation(tx, c, { kind: "target_edit", month, action: t ? "edit_target" : "remove_target", args: { categoryId: cat.id, target: t, month }, rows, entity: "category", entityId: cat.id });
    const r = await w.finish(month);
    return { operationId, changes: [], rtaDelta: 0n, recomputedFrom: r.writtenFrom };
  });
}

/** Snooze (or un-snooze) a target for one month: needed = 0 that month only (§6.5). */
export async function snoozeTarget(ctx: Ctx, input: { categoryId: string; month: Month; snoozed?: boolean }): Promise<OperationResult> {
  MonthSchema.parse(input.month);
  const snoozed = input.snoozed ?? true;
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    const row = await effectiveTargetRow(tx, input.categoryId, input.month);
    if (!row) throw new ValidationError("category has no target in that month");
    const pk = { category_id: input.categoryId, effective_from: input.month };
    let change: RowChange;
    if (snoozed) {
      if (row.snoozedMonth === input.month) {
        await w.finish(null);
        return { operationId: null, changes: [], rtaDelta: 0n, recomputedFrom: null };
      }
      change = await trackRow(tx, "targets", pk, async () => {
        if (row.effectiveFrom === input.month) await tx.update(targets).set({ snoozedMonth: input.month }).where(and(eq(targets.categoryId, input.categoryId), eq(targets.effectiveFrom, input.month)));
        else {
          // copy the target into this month so the snooze can't disturb earlier months
          const { createdAt: _c, updatedAt: _u, ...copy } = row;
          await tx.insert(targets).values({ ...copy, effectiveFrom: input.month, snoozedMonth: input.month });
        }
      });
    } else {
      if (row.snoozedMonth !== input.month) {
        await w.finish(null);
        return { operationId: null, changes: [], rtaDelta: 0n, recomputedFrom: null };
      }
      const rowPk = { category_id: input.categoryId, effective_from: row.effectiveFrom };
      change = await trackRow(tx, "targets", rowPk, () =>
        tx.update(targets).set({ snoozedMonth: null }).where(and(eq(targets.categoryId, input.categoryId), eq(targets.effectiveFrom, row.effectiveFrom))),
      );
    }
    const operationId = await recordOperation(tx, c, { kind: "target_edit", month: input.month, action: "snooze_target", args: { categoryId: input.categoryId, month: input.month, snoozed }, rows: [change], entity: "category", entityId: input.categoryId });
    const r = await w.finish(input.month);
    return { operationId, changes: [], rtaDelta: 0n, recomputedFrom: r.writtenFrom };
  });
}

// ── categories and groups ───────────────────────────────────────────────────

async function getCategory(tx: DbLike, id: string) {
  return assertFound((await tx.select().from(categories).where(eq(categories.id, id)))[0], "category", id);
}
async function getGroup(tx: DbLike, id: string) {
  return assertFound((await tx.select().from(categoryGroups).where(eq(categoryGroups.id, id)))[0], "category group", id);
}

async function categoryOp(ctx: Ctx, kind: "category_edit" | "group_edit", action: string, args: Record<string, unknown>, body: (tx: Tx) => Promise<{ rows: RowChange[]; entityId: string }>): Promise<OperationResult & { entityId: string }> {
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    const { rows, entityId } = await body(tx);
    const real = rows.filter((r) => JSON.stringify(r.before) !== JSON.stringify(r.after));
    const operationId = real.length ? await recordOperation(tx, c, { kind, month: null, action, args, rows: real, entity: kind === "group_edit" ? "category_group" : "category", entityId }) : null;
    await w.finish(null);
    return { operationId, changes: [], rtaDelta: 0n, recomputedFrom: null, entityId };
  });
}

const NameSchema = z.string().trim().min(1).max(100);

export async function createGroup(ctx: Ctx, input: { name: string }) {
  const name = NameSchema.parse(input.name);
  return categoryOp(ctx, "group_edit", "create_group", { name }, async (tx) => {
    const [m] = await tx.select({ s: max(categoryGroups.sort) }).from(categoryGroups);
    const id = newId();
    const row = await trackRow(tx, "category_groups", { id }, () => tx.insert(categoryGroups).values({ id, name, sort: (m?.s ?? 0) + 1 }));
    return { rows: [row], entityId: id };
  });
}

/** Create a category at the bottom of a (non-system) group. */
export async function createCategory(ctx: Ctx, input: { groupId: string; name: string; note?: string | null; icon?: string | null }) {
  const name = NameSchema.parse(input.name);
  if (input.icon != null && !isIconKey(input.icon)) throw new ValidationError(`invalid icon key: ${input.icon}`);
  // Default icon from the name's keywords ("circle-dot" when nothing matches); null only when asked.
  const icon = input.icon === undefined ? suggestCategoryIcon(name) : input.icon;
  return categoryOp(ctx, "category_edit", "create_category", { groupId: input.groupId, name }, async (tx) => {
    const g = await getGroup(tx, input.groupId);
    if (g.isSystem) throw new ValidationError(`can't add categories to ${g.name}`);
    const [m] = await tx.select({ s: max(categories.sort) }).from(categories).where(eq(categories.groupId, g.id));
    const id = newId();
    const row = await trackRow(tx, "categories", { id }, () => tx.insert(categories).values({ id, groupId: g.id, name, icon, note: input.note ?? null, sort: (m?.s ?? -1) + 1 }));
    return { rows: [row], entityId: id };
  });
}

export async function renameCategory(ctx: Ctx, id: string, name: string) {
  const n = NameSchema.parse(name);
  return categoryOp(ctx, "category_edit", "rename_category", { id, name: n }, async (tx) => {
    const cat = await getCategory(tx, id);
    if (cat.kind === "internal_rta" || cat.kind === "uncategorized") throw new ValidationError(`${cat.name} can't be renamed`);
    return { rows: [await trackRow(tx, "categories", { id }, () => tx.update(categories).set({ name: n }).where(eq(categories.id, id)))], entityId: id };
  });
}

/** Edit a category's note / "always review" flag (§9.4). */
export async function updateCategory(ctx: Ctx, id: string, patch: { note?: string | null; alwaysReview?: boolean }) {
  return categoryOp(ctx, "category_edit", "update_category", { id, ...patch }, async (tx) => {
    await getCategory(tx, id);
    const set: Partial<typeof categories.$inferInsert> = {};
    if (patch.note !== undefined) set.note = patch.note?.trim() || null;
    if (patch.alwaysReview !== undefined) set.alwaysReview = patch.alwaysReview;
    if (Object.keys(set).length === 0) return { rows: [], entityId: id };
    return { rows: [await trackRow(tx, "categories", { id }, () => tx.update(categories).set(set).where(eq(categories.id, id)))], entityId: id };
  });
}

/**
 * Set (or clear) a category's lucide icon key (kebab-case, e.g. "piggy-bank"). Audited and undoable
 * like the other category edits; any category kind may carry an icon.
 */
export async function setCategoryIcon(ctx: Ctx, categoryId: string, icon: string | null) {
  const value = icon === null ? null : icon.trim();
  if (value !== null && !isIconKey(value)) throw new ValidationError(`invalid icon key: ${icon}`);
  return categoryOp(ctx, "category_edit", "set_category_icon", { id: categoryId, icon: value }, async (tx) => {
    await getCategory(tx, categoryId);
    return { rows: [await trackRow(tx, "categories", { id: categoryId }, () => tx.update(categories).set({ icon: value }).where(eq(categories.id, categoryId)))], entityId: categoryId };
  });
}

export interface BucketRolloverInput {
  enabled: boolean;
  /** Carried into the first month (money already saved). Default 0 when turning it on; kept otherwise. */
  openingMilli?: Milli;
  /** First month the rollover counts. Default: the current month when turning it on; kept when it is already on. */
  fromMonth?: Month;
}

/**
 * Buckets: overflow (rollover) on or off (ADR "Buckets: overflow (rollover)"). Turning it on sets
 * `rollover_from` (the current month unless given) and the opening amount; turning it off keeps both
 * columns as history but stops the carry. A `category_edit` operation: audited and undoable.
 */
export async function setBucketRollover(ctx: Ctx, categoryId: string, input: BucketRolloverInput) {
  const i = z
    .object({
      enabled: z.boolean(),
      openingMilli: z.bigint().nonnegative().optional(),
      fromMonth: z.string().regex(/^\d{4}-\d{2}-01$/).optional(),
    })
    .parse(input);
  return categoryOp(ctx, "category_edit", i.enabled ? "enable_rollover" : "disable_rollover", { id: categoryId, enabled: i.enabled, openingMilli: i.openingMilli?.toString() ?? null, fromMonth: i.fromMonth ?? null }, async (tx) => {
    const cat = await getCategory(tx, categoryId);
    if (cat.kind !== "normal") throw new ValidationError(`${cat.name} can't roll over`);
    if (i.enabled && cat.bucketKind === "savings") throw new ValidationError(`${cat.name} is a savings bucket: its balance already carries over`);
    const set: Partial<typeof categories.$inferInsert> = { rollover: i.enabled };
    if (i.enabled) {
      const turningOn = !cat.rollover;
      if (i.fromMonth) set.rolloverFrom = i.fromMonth;
      else if (turningOn || !cat.rolloverFrom) set.rolloverFrom = monthOf(ctxToday(ctx));
      if (i.openingMilli !== undefined) set.rolloverOpeningMilli = i.openingMilli;
      else if (turningOn) set.rolloverOpeningMilli = 0n;
    }
    return { rows: [await trackRow(tx, "categories", { id: categoryId }, () => tx.update(categories).set(set).where(eq(categories.id, categoryId)))], entityId: categoryId };
  });
}

// ── savings buckets ─────────────────────────────────────────────────────────
// ADR "Buckets: savings buckets". No monthly goal: money is added as it comes in (an assignment in that
// month) and the balance carries month to month. Reuses `rollover_from` (start) and
// `rollover_opening_milli` (starting balance); `savings_target_milli` is an optional target total.

const MAX_MILLI = 100_000_000_000n; // $100M

export interface SavingsBucketInput {
  enabled: boolean;
  /** Starting balance carried into the first month. Default 0 when turning it on; kept otherwise. */
  openingMilli?: Milli;
  /** First month that counts. Default: the current month when turning it on; kept when already savings. */
  fromMonth?: Month;
  /** Target total; null clears it. Not given: kept (or, when turning it on, a balance goal's amount). */
  targetMilli?: Milli | null;
}

/**
 * Make a bucket a savings bucket (or a spending bucket again). Turning it on sets `bucket_kind`, the
 * start month (the current month unless given) and the starting balance, turns overflow off (the savings
 * carry is built in) and removes the bucket's goal from the start month on, so it never counts as
 * spending money; a balance goal's amount becomes the savings target unless one is given. Turning it off
 * only sets `bucket_kind = 'spending'` (start, balance and target stay as history). One `category_edit`
 * operation (`enable_savings` / `disable_savings`): audited and undoable, goal rows included.
 */
export async function setSavingsBucket(ctx: Ctx, categoryId: string, input: SavingsBucketInput) {
  const i = z
    .object({
      enabled: z.boolean(),
      openingMilli: z.bigint().nonnegative().max(MAX_MILLI).optional(),
      fromMonth: MonthSchema.optional(),
      targetMilli: z.bigint().positive().max(MAX_MILLI).nullable().optional(),
    })
    .parse(input);
  const action = i.enabled ? "enable_savings" : "disable_savings";
  const args = { id: categoryId, enabled: i.enabled, openingMilli: i.openingMilli?.toString() ?? null, fromMonth: i.fromMonth ?? null, targetMilli: i.targetMilli === undefined ? undefined : (i.targetMilli?.toString() ?? null) };
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    const cat = await getCategory(tx, categoryId);
    if (cat.kind !== "normal") throw new ValidationError(`${cat.name} can't be a savings bucket`);
    if (cat.deletedAt) throw new ValidationError(`${cat.name} is deleted`);
    const rows: RowChange[] = [];
    const set: Partial<typeof categories.$inferInsert> = { bucketKind: i.enabled ? "savings" : "spending" };
    let goalFrom: Month | null = null;
    if (i.enabled) {
      const turningOn = cat.bucketKind !== "savings";
      const from = i.fromMonth ?? (turningOn || !cat.rolloverFrom ? monthOf(ctxToday(c)) : cat.rolloverFrom);
      set.rolloverFrom = from;
      set.rollover = false;
      if (i.openingMilli !== undefined) set.rolloverOpeningMilli = i.openingMilli;
      else if (turningOn) set.rolloverOpeningMilli = 0n;
      if (i.targetMilli !== undefined) set.savingsTargetMilli = i.targetMilli;
      // no goal from the start month on: drop later goal rows, end the one in effect
      const later = await tx.select({ ef: targets.effectiveFrom }).from(targets).where(and(eq(targets.categoryId, cat.id), gt(targets.effectiveFrom, from)));
      for (const l of later) rows.push(await trackRow(tx, "targets", { category_id: cat.id, effective_from: l.ef }, () => tx.delete(targets).where(and(eq(targets.categoryId, cat.id), eq(targets.effectiveFrom, l.ef)))));
      const prev = await effectiveTargetRow(tx, cat.id, from);
      if (prev) {
        if (i.targetMilli === undefined && turningOn && (prev.type === "balance" || prev.type === "balance_by_date") && prev.amountMilli > 0n) set.savingsTargetMilli = prev.amountMilli;
        const removed = { type: prev.type, amountMilli: 0n, cadence: prev.cadence, cadenceEvery: 1, day: null, targetDate: null, percent: null, incomeBasis: null, snoozedMonth: null, removed: true };
        rows.push(
          await trackRow(tx, "targets", { category_id: cat.id, effective_from: from }, () =>
            tx
              .insert(targets)
              .values({ categoryId: cat.id, effectiveFrom: from, createdMonth: from, ...removed })
              .onConflictDoUpdate({ target: [targets.categoryId, targets.effectiveFrom], set: { ...removed, updatedAt: new Date() } }),
          ),
        );
      }
      if (rows.length) goalFrom = from;
    }
    rows.unshift(await trackRow(tx, "categories", { id: cat.id }, () => tx.update(categories).set(set).where(eq(categories.id, cat.id))));
    const real = rows.filter((r) => JSON.stringify(r.before) !== JSON.stringify(r.after));
    const operationId = real.length ? await recordOperation(tx, c, { kind: "category_edit", month: null, action, args, rows: real, entity: "category", entityId: cat.id }) : null;
    const r = await w.finish(goalFrom);
    return { operationId, changes: [] as AssignmentChange[], rtaDelta: 0n, recomputedFrom: r.writtenFrom, entityId: cat.id };
  });
}

/** A savings bucket's target total (null clears it). Audited and undoable. */
export async function setSavingsTarget(ctx: Ctx, categoryId: string, targetMilli: Milli | null) {
  const t = z.bigint().positive().max(MAX_MILLI).nullable().parse(targetMilli);
  return categoryOp(ctx, "category_edit", "set_savings_target", { id: categoryId, targetMilli: t?.toString() ?? null }, async (tx) => {
    const cat = await getCategory(tx, categoryId);
    if (cat.bucketKind !== "savings") throw new ValidationError(`${cat.name} isn't a savings bucket`);
    return { rows: [await trackRow(tx, "categories", { id: categoryId }, () => tx.update(categories).set({ savingsTargetMilli: t }).where(eq(categories.id, categoryId)))], entityId: categoryId };
  });
}

/**
 * Add money to a savings bucket (positive) or take it out (negative) in `month` (default: the current
 * month): that month's assignment goes up or down by `amountMilli`, an ordinary `assign` operation
 * (`budget.add_to_savings` / `budget.take_from_savings`), so Undo works like any assign. Taking out more
 * than the bucket's balance at the end of that month is refused, as is a month before the bucket starts.
 */
export async function addToSavings(ctx: Ctx, categoryId: string, amountMilli: Milli, month?: Month): Promise<OperationResult> {
  const amount = z.bigint().min(-MAX_MILLI).max(MAX_MILLI).parse(amountMilli);
  const m = MonthSchema.parse(month ?? monthOf(ctxToday(ctx)));
  if (amount === 0n) throw new ValidationError("amount can't be zero");
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    const cat = await assignableCategory(tx, categoryId);
    const settings = await savingsSettings(tx, [cat.id]);
    const sv = settings.get(cat.id);
    if (!sv) throw new ValidationError(`${cat.name} isn't a savings bucket`);
    if (m < sv.from) throw new ValidationError(`${cat.name} starts saving in ${sv.from.slice(0, 7)}`);
    const balance = (await savingsMonths(tx, m, settings)).get(cat.id)?.balance ?? 0n;
    const err = savingsChangeError(balance, amount);
    if (err) throw new ValidationError(amount < 0n ? `Can't take out ${formatMilli(-amount)}: ${cat.name} has ${formatMilli(balance > 0n ? balance : 0n)}` : err);
    const cur = await currentAssigned(tx, m, cat.id);
    const changes = engineAssign(() => cur, { month: m, categoryId: cat.id, to: cur + amount });
    const action = amount > 0n ? "add_to_savings" : "take_from_savings";
    return commitChanges(tx, c, w, { kind: "assign", month: m, action, args: { categoryId: cat.id, amount, month: m }, changes, entity: "category", entityId: cat.id });
  });
}

export async function renameGroup(ctx: Ctx, id: string, name: string) {
  const n = NameSchema.parse(name);
  return categoryOp(ctx, "group_edit", "rename_group", { id, name: n }, async (tx) => {
    const g = await getGroup(tx, id);
    if (g.isSystem) throw new ValidationError(`${g.name} can't be renamed`);
    return { rows: [await trackRow(tx, "category_groups", { id }, () => tx.update(categoryGroups).set({ name: n }).where(eq(categoryGroups.id, id)))], entityId: id };
  });
}

/** Hide/unhide a category: excluded from views, still in the math (§6.8). */
export async function setCategoryHidden(ctx: Ctx, id: string, hidden: boolean) {
  return categoryOp(ctx, "category_edit", hidden ? "hide_category" : "unhide_category", { id }, async (tx) => {
    const cat = await getCategory(tx, id);
    if (cat.kind === "internal_rta") throw new ValidationError("Ready to Assign can't be shown or hidden");
    return { rows: [await trackRow(tx, "categories", { id }, () => tx.update(categories).set({ hidden }).where(eq(categories.id, id)))], entityId: id };
  });
}
export const hideCategory = (ctx: Ctx, id: string) => setCategoryHidden(ctx, id, true);
export const unhideCategory = (ctx: Ctx, id: string) => setCategoryHidden(ctx, id, false);

export async function setGroupHidden(ctx: Ctx, id: string, hidden: boolean) {
  return categoryOp(ctx, "group_edit", hidden ? "hide_group" : "unhide_group", { id }, async (tx) => {
    await getGroup(tx, id);
    return { rows: [await trackRow(tx, "category_groups", { id }, () => tx.update(categoryGroups).set({ hidden }).where(eq(categoryGroups.id, id)))], entityId: id };
  });
}

/** Set the order of categories inside a group; ids from other groups are moved into it. */
export async function reorderCategories(ctx: Ctx, input: { groupId: string; categoryIds: string[] }) {
  return categoryOp(ctx, "category_edit", "reorder_categories", input, async (tx) => {
    const g = await getGroup(tx, input.groupId);
    const rows: RowChange[] = [];
    for (const [i, id] of input.categoryIds.entries()) {
      const cat = await getCategory(tx, id);
      if (cat.groupId !== g.id && (g.isSystem || cat.kind !== "normal")) throw new ValidationError(`${cat.name} can't move to ${g.name}`);
      if (cat.sort === i && cat.groupId === g.id) continue;
      rows.push(await trackRow(tx, "categories", { id }, () => tx.update(categories).set({ sort: i, groupId: g.id }).where(eq(categories.id, id))));
    }
    return { rows, entityId: g.id };
  });
}

export async function reorderGroups(ctx: Ctx, groupIds: string[]) {
  return categoryOp(ctx, "group_edit", "reorder_groups", { groupIds }, async (tx) => {
    const rows: RowChange[] = [];
    for (const [i, id] of groupIds.entries()) {
      const g = await getGroup(tx, id);
      if (g.sort === i) continue;
      rows.push(await trackRow(tx, "category_groups", { id }, () => tx.update(categoryGroups).set({ sort: i }).where(eq(categoryGroups.id, id))));
    }
    return { rows, entityId: groupIds[0] ?? "" };
  });
}

/**
 * Merge `sourceId` into `targetId` (§12.6 "merging recategorizes history"): every transaction, split,
 * scheduled transaction and payee default moves to the target, assignments are summed into it, notes
 * move, and the source is soft-deleted. Logged, but not undoable. No categorization_events are written:
 * a merge is a structural change, not a correction to learn from.
 */
export async function mergeCategories(ctx: Ctx, input: { sourceId: string; targetId: string }) {
  if (input.sourceId === input.targetId) throw new ValidationError("can't merge a category into itself");
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    const src = await getCategory(tx, input.sourceId);
    const dst = await getCategory(tx, input.targetId);
    if (src.kind !== "normal" || dst.kind !== "normal") throw new ValidationError("only normal categories can be merged");
    if (dst.deletedAt) throw new ValidationError(`${dst.name} is deleted`);
    const firstTx = await tx
      .select({ d: sql<string | null>`least((SELECT min(date) FROM transactions WHERE category_id = ${src.id}), (SELECT min(t.date) FROM transaction_splits s JOIN transactions t ON t.id = s.transaction_id WHERE s.category_id = ${src.id}), (SELECT min(month) FROM month_assignments WHERE category_id = ${src.id}))` })
      .from(sql`(SELECT 1) x`);
    const moved = await tx.update(transactions).set({ categoryId: dst.id }).where(eq(transactions.categoryId, src.id)).returning({ id: transactions.id });
    const movedSplits = await tx.update(transactionSplits).set({ categoryId: dst.id }).where(eq(transactionSplits.categoryId, src.id)).returning({ id: transactionSplits.id });
    await tx.update(scheduledTransactions).set({ categoryId: dst.id }).where(eq(scheduledTransactions.categoryId, src.id));
    await tx.update(scheduledTransactionSplits).set({ categoryId: dst.id }).where(eq(scheduledTransactionSplits.categoryId, src.id));
    await tx.update(payees).set({ defaultCategoryId: dst.id }).where(eq(payees.defaultCategoryId, src.id));
    const asg = await tx.select().from(monthAssignments).where(eq(monthAssignments.categoryId, src.id));
    for (const a of asg) {
      await tx
        .insert(monthAssignments)
        .values({ month: a.month, categoryId: dst.id, assignedMilli: a.assignedMilli })
        .onConflictDoUpdate({ target: [monthAssignments.month, monthAssignments.categoryId], set: { assignedMilli: sql`${monthAssignments.assignedMilli} + ${a.assignedMilli}`, updatedAt: new Date() } });
    }
    await tx.delete(monthAssignments).where(eq(monthAssignments.categoryId, src.id));
    const notes = await tx.select().from(monthNotes).where(eq(monthNotes.categoryId, src.id));
    for (const n of notes) {
      const [existing] = await tx.select().from(monthNotes).where(and(eq(monthNotes.month, n.month), eq(monthNotes.categoryId, dst.id)));
      if (existing) {
        await tx.update(monthNotes).set({ note: `${existing.note}\n${n.note}` }).where(eq(monthNotes.id, existing.id));
        await tx.delete(monthNotes).where(eq(monthNotes.id, n.id));
      } else await tx.update(monthNotes).set({ categoryId: dst.id }).where(eq(monthNotes.id, n.id));
    }
    await tx.update(categories).set({ deletedAt: new Date(), hidden: true }).where(eq(categories.id, src.id));
    const args = { sourceId: src.id, sourceName: src.name, targetId: dst.id, targetName: dst.name, transactions: moved.length, splits: movedSplits.length, assignments: asg.length };
    const operationId = await recordOperation(tx, c, { kind: "category_edit", month: null, action: "merge_categories", args, entity: "category", entityId: dst.id, irreversible: true });
    const d = firstTx[0]?.d ?? null;
    const r = await w.finish(d ? monthOf(String(d)) : null);
    return { operationId, changes: [], rtaDelta: 0n, recomputedFrom: r.writtenFrom, ...args };
  });
}

/** Category list (for pickers): groups in order with their categories. */
export async function listCategories(db: DbLike, opts: { includeHidden?: boolean; includeDeleted?: boolean } = {}) {
  const groups = await db.select().from(categoryGroups).where(opts.includeDeleted ? undefined : isNull(categoryGroups.deletedAt)).orderBy(asc(categoryGroups.sort), asc(categoryGroups.name));
  const cats = await db.select().from(categories).where(opts.includeDeleted ? undefined : isNull(categories.deletedAt)).orderBy(asc(categories.sort), asc(categories.name));
  return groups
    .filter((g) => opts.includeHidden || !g.hidden || g.isSystem)
    .map((g) => ({ ...g, categories: cats.filter((c) => c.groupId === g.id && (opts.includeHidden || !c.hidden)) }))
    .filter((g) => g.categories.length > 0 || !g.isSystem);
}

