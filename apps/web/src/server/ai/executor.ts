/**
 * ActionExecutor for confirmed Ask write tools (§11.3). Every write goes through @homebase/core with
 * `aiCtx(db, requester, confirmedBy)`, so core enforces "no AI write without a confirming user" and
 * writes its own audit rows (actor=ai, confirmed_by=<user>).
 *
 * Core functions are injected (`deps`) so the mapping is unit-tested without Postgres.
 */
import * as core from "@homebase/core";
import { testRuleAgainstHistory } from "@homebase/categorizer";
import { normalizeMonth, READY_TO_ASSIGN_ID, type ActionExecutor, type ExecutedWrite } from "@homebase/ai";
import { absMilli, parseMilli, type ISODate, type Milli } from "@homebase/shared";
import type { Db } from "@homebase/db";
import { aiRuleToCanonical } from "./rules";
import type { HistorySubject } from "../settings/rules";

type Ctx = core.Ctx;

/** The core surface the executor needs. Defaults to the real @homebase/core plus the web's rule helpers. */
export interface ExecutorDeps {
  recategorize: (ctx: Ctx, ids: string[], categoryId: string | null) => Promise<{ updated: string[]; skipped: { id: string; reason: string }[]; total: Milli }>;
  splitTransaction: (ctx: Ctx, id: string, lines: { amount: bigint; categoryId: string | null; memo?: string | null }[]) => Promise<{ id: string }>;
  getTransactionAmount: (db: Db, id: string) => Promise<{ amount: Milli; categoryId: string | null; isSplit: boolean }>;
  approveTransactions: (ctx: Ctx, ids: string[]) => Promise<{ approved: string[] }>;
  assign: (ctx: Ctx, input: { month: string; categoryId: string; amount?: Milli; expr?: string }) => Promise<{ operationId: string | null }>;
  moveMoney: (ctx: Ctx, input: { month: string; from: string; to: string; amount: Milli }) => Promise<{ operationId: string | null }>;
  autoAssign: (ctx: Ctx, input: { month: string; mode: core.AutoAssignInput["mode"]; categoryIds?: string[] }) => Promise<{ operationId: string | null; changes: unknown[] }>;
  listGroups: (db: Db) => Promise<{ id: string; name: string; isSystem: boolean }[]>;
  createGroup: (ctx: Ctx, input: { name: string }) => Promise<{ entityId: string }>;
  createCategory: (ctx: Ctx, input: { groupId: string; name: string }) => Promise<{ entityId: string }>;
  editTarget: (ctx: Ctx, input: { categoryId: string; target: core.TargetInput | null }) => Promise<{ operationId: string | null }>;
  addMemory: (ctx: Ctx, text: string) => Promise<{ id: string }>;
  insertRule: (ctx: Ctx, input: { name?: string | null; rule: ReturnType<typeof aiRuleToCanonical> }) => Promise<string>;
  loadRuleSubjects: (db: Db) => Promise<HistorySubject[]>;
}

export interface ExecutorOptions {
  db: Db;
  /** The user who asked (ai_conversations.user_id). */
  requestedBy: string | null;
  today?: ISODate;
  deps: ExecutorDeps;
}

const RTA_CORE = "rta";
const endpoint = (id: string) => (id === READY_TO_ASSIGN_ID ? RTA_CORE : id);

export function createActionExecutor(o: ExecutorOptions): ActionExecutor {
  const { db, deps } = o;
  const ctxFor = (confirmedBy: string): Ctx => core.aiCtx(db, o.requestedBy, confirmedBy, o.today);

  return {
    async recategorize(input, meta): Promise<ExecutedWrite> {
      const r = await deps.recategorize(ctxFor(meta.confirmedBy), [...new Set(input.transaction_ids)], input.category_id);
      if (r.updated.length === 0) throw new Error(r.skipped.length ? `Nothing changed: ${r.skipped.map((s) => s.reason).join(", ")}` : "Nothing changed");
      return {
        entity: "transaction",
        entityId: r.updated.length === 1 ? r.updated[0]! : null,
        after: { categoryId: input.category_id, updated: r.updated, skipped: r.skipped },
        summary: `Moved ${r.updated.length} transaction${r.updated.length === 1 ? "" : "s"}${r.skipped.length ? ` (${r.skipped.length} skipped)` : ""}`,
      };
    },

    async split_transaction(input, meta) {
      const t = await deps.getTransactionAmount(db, input.transaction_id);
      const sign = t.amount < 0n ? -1n : 1n;
      const lines = input.lines.map((l) => ({ amount: sign * absMilli(parseMilli(l.amount)), categoryId: l.category_id, memo: l.memo ?? null }));
      await deps.splitTransaction(ctxFor(meta.confirmedBy), input.transaction_id, lines);
      return { entity: "transaction", entityId: input.transaction_id, before: { categoryId: t.categoryId, isSplit: t.isSplit }, after: { lines: input.lines }, summary: `Split into ${lines.length} lines` };
    },

    async approve(input, meta) {
      const r = await deps.approveTransactions(ctxFor(meta.confirmedBy), [...new Set(input.transaction_ids)]);
      return { entity: "transaction", entityId: r.approved.length === 1 ? r.approved[0]! : null, after: { approved: r.approved }, summary: `Approved ${r.approved.length}` };
    },

    async create_rule(input, meta) {
      const canonical = aiRuleToCanonical(input);
      const ctx = ctxFor(meta.confirmedBy);
      const ruleId = await deps.insertRule(ctx, { name: input.payee_equals ?? input.payee_contains ?? input.description_contains ?? null, rule: canonical });
      let applied = 0;
      if (input.apply_to_existing && canonical.actions.setCategoryId) {
        const target = canonical.actions.setCategoryId;
        const history = await deps.loadRuleSubjects(db);
        const matched = new Set(testRuleAgainstHistory(canonical, history, history.length).sampleIds);
        // Only rows whose category would change.
        const change = history.filter((h) => matched.has(h.id) && h.categoryId !== target).map((h) => h.id);
        if (change.length) applied = (await deps.recategorize(ctx, change, target)).updated.length;
      }
      return { entity: "rule", entityId: ruleId, after: { ...canonical, appliedTo: applied }, summary: applied ? `Rule created and applied to ${applied}` : "Rule created" };
    },

    async assign(input, meta) {
      const month = normalizeMonth(input.month);
      const amount = parseMilli(input.amount);
      const r = await deps.assign(ctxFor(meta.confirmedBy), input.mode === "add" ? { month, categoryId: input.category_id, expr: `+${input.amount}` } : { month, categoryId: input.category_id, amount });
      return { entity: "category", entityId: input.category_id, after: { month, mode: input.mode, amount: input.amount, operationId: r.operationId } };
    },

    async move_money(input, meta) {
      const month = normalizeMonth(input.month);
      const r = await deps.moveMoney(ctxFor(meta.confirmedBy), { month, from: endpoint(input.from_category_id), to: endpoint(input.to_category_id), amount: parseMilli(input.amount) });
      return { entity: "category", entityId: input.to_category_id === READY_TO_ASSIGN_ID ? input.from_category_id : input.to_category_id, after: { month, from: input.from_category_id, to: input.to_category_id, amount: input.amount, operationId: r.operationId } };
    },

    async auto_assign(input, meta) {
      const month = normalizeMonth(input.month);
      const r = await deps.autoAssign(ctxFor(meta.confirmedBy), { month, mode: input.mode, ...(input.category_ids?.length ? { categoryIds: input.category_ids } : {}) });
      return { entity: "month", entityId: month, after: { mode: input.mode, changes: r.changes.length, operationId: r.operationId }, summary: `${r.changes.length} categories changed` };
    },

    async create_category(input, meta) {
      const ctx = ctxFor(meta.confirmedBy);
      const want = input.group.trim().toLowerCase();
      const groups = await deps.listGroups(db);
      let group = groups.find((g) => !g.isSystem && g.name.trim().toLowerCase() === want);
      let createdGroup = false;
      if (!group) {
        const g = await deps.createGroup(ctx, { name: input.group.trim() });
        group = { id: g.entityId, name: input.group.trim(), isSystem: false };
        createdGroup = true;
      }
      const c = await deps.createCategory(ctx, { groupId: group.id, name: input.name.trim() });
      return { entity: "category", entityId: c.entityId, after: { name: input.name.trim(), group: group.name, createdGroup } };
    },

    async update_target(input, meta) {
      const t = input.target;
      const target: core.TargetInput = {
        type: t.type,
        ...(t.amount !== undefined ? { amount: parseMilli(t.amount) } : {}),
        ...(t.cadence !== undefined ? { cadence: t.cadence } : {}),
        ...(t.cadence_every !== undefined ? { cadenceEvery: t.cadence_every } : {}),
        ...(t.day !== undefined ? { day: t.day } : {}),
        ...(t.target_date !== undefined ? { targetDate: t.target_date } : {}),
        ...(t.percent !== undefined ? { percent: t.percent } : {}),
      };
      const r = await deps.editTarget(ctxFor(meta.confirmedBy), { categoryId: input.category_id, target });
      return { entity: "category", entityId: input.category_id, after: { target: input.target, operationId: r.operationId } };
    },

    async remember(input, meta) {
      const m = await deps.addMemory(ctxFor(meta.confirmedBy), input.fact.trim());
      return { entity: "household_memory", entityId: m.id, after: { text: input.fact.trim() } };
    },
  };
}
