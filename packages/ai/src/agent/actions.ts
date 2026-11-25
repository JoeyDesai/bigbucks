/**
 * Write tools never execute in the agent loop (§11.3, CLAUDE.md "no AI write without
 * confirmation"). They become pending action cards with a human-readable diff; the UI's Confirm
 * button calls `executeConfirmedAction()`, which runs the injected executor exactly once and writes
 * an audit_log entry with actor=ai, confirmed_by=<user>.
 */
import { absMilli, formatMilli, formatMonth, newId, parseMilli, sumMilli, type Milli } from "@homebase/shared";
import type { ActionExecutor, AiToolContext, AuditSink, CategoryRef, ExecutedWrite, PendingAction, PendingActionStore } from "./context";
import { normalizeMonth, READY_TO_ASSIGN_ID, WRITE_TOOL_SCHEMAS, type WriteToolInput, type WriteToolName } from "./schemas";

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

const q = (s: string) => `“${s}”`;
const plural = (n: number, w: string, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;
const money = (m: Milli) => formatMilli(m, { sign: "never" });

async function categoryNamer(ctx: AiToolContext): Promise<(id: string) => string> {
  const cats = await ctx.getCategories();
  const byId = new Map<string, CategoryRef>(cats.map((c) => [c.id, c]));
  return (id: string) => {
    if (id === READY_TO_ASSIGN_ID) return "Ready to Assign";
    const c = byId.get(id);
    if (!c) throw new ToolInputError(`Unknown category id ${id}. Use an id from the category list.`);
    return c.name;
  };
}

type DiffBuilder<K extends WriteToolName> = (input: WriteToolInput<K>, ctx: AiToolContext) => Promise<string>;

const DIFFS: { [K in WriteToolName]: DiffBuilder<K> } = {
  async recategorize(input, ctx) {
    const name = await categoryNamer(ctx);
    const to = name(input.category_id);
    const ids = [...new Set(input.transaction_ids)];
    const txns = await ctx.getTransactionsByIds(ids);
    if (txns.length !== ids.length) throw new ToolInputError(`${ids.length - txns.length} transaction id(s) were not found`);
    const fromIds = [...new Set(txns.map((t) => (t.isSplit ? "__split" : (t.categoryId ?? "__none"))))];
    let from: string;
    if (fromIds.length === 1) {
      const f = fromIds[0]!;
      from = f === "__split" ? "split lines" : f === "__none" ? "Uncategorized" : name(f);
    } else from = `${fromIds.length} categories`;
    const total = absMilli(sumMilli(txns.map((t) => t.amount)));
    return `Move ${plural(txns.length, "transaction")} (${money(total)}) from ${from} → ${to}`;
  },

  async split_transaction(input, ctx) {
    const name = await categoryNamer(ctx);
    const [t] = await ctx.getTransactionsByIds([input.transaction_id]);
    if (!t) throw new ToolInputError(`Transaction ${input.transaction_id} was not found`);
    const lines = input.lines.map((l) => ({ name: name(l.category_id), amount: parseMilli(l.amount) }));
    const total = sumMilli(lines.map((l) => l.amount));
    if (total !== absMilli(t.amount)) {
      throw new ToolInputError(`Split lines add up to ${money(total)} but the transaction is ${money(absMilli(t.amount))}`);
    }
    return `Split ${t.payee ?? "transaction"} ${money(absMilli(t.amount))} (${t.date}) into ${lines.map((l) => `${l.name} ${money(l.amount)}`).join(" + ")}`;
  },

  async approve(input, ctx) {
    const ids = [...new Set(input.transaction_ids)];
    const txns = await ctx.getTransactionsByIds(ids);
    if (txns.length !== ids.length) throw new ToolInputError(`${ids.length - txns.length} transaction id(s) were not found`);
    return `Approve ${plural(txns.length, "transaction")} (${money(absMilli(sumMilli(txns.map((t) => t.amount))))})`;
  },

  async create_rule(input, ctx) {
    const name = await categoryNamer(ctx);
    const cond: string[] = [];
    if (input.payee_equals) cond.push(`payee is ${q(input.payee_equals)}`);
    if (input.payee_contains) cond.push(`payee contains ${q(input.payee_contains)}`);
    if (input.description_contains) cond.push(`description contains ${q(input.description_contains)}`);
    if (input.min_abs_amount && input.max_abs_amount) cond.push(`amount ${money(parseMilli(input.min_abs_amount))}–${money(parseMilli(input.max_abs_amount))}`);
    else if (input.min_abs_amount) cond.push(`amount ≥ ${money(parseMilli(input.min_abs_amount))}`);
    else if (input.max_abs_amount) cond.push(`amount ≤ ${money(parseMilli(input.max_abs_amount))}`);
    if (input.account_ids?.length) cond.push(`account in ${plural(input.account_ids.length, "account")}`);
    const act: string[] = [];
    if (input.category_id) act.push(name(input.category_id));
    if (input.set_payee_name) act.push(`rename payee to ${q(input.set_payee_name)}`);
    if (input.auto_approve) act.push("auto-approve");
    let s = `Create rule: ${cond.join(" and ")} → ${act.join(", ")}`;
    if (input.apply_to_existing) {
      const preview = ctx.previewRule ? await ctx.previewRule(input) : null;
      s += preview ? `; apply to ${plural(preview.matchCount, "existing transaction")}` : "; apply to existing matching transactions";
    }
    return s;
  },

  async assign(input, ctx) {
    const name = await categoryNamer(ctx);
    const month = normalizeMonth(input.month);
    const cat = name(input.category_id);
    const amount = parseMilli(input.amount);
    const bm = await ctx.getBudgetMonth(month);
    const row = bm.categories.find((c) => c.categoryId === input.category_id);
    const verb = input.mode === "add" ? `Assign ${money(amount)} more to` : `Set Assigned to ${money(amount)} for`;
    let s = `${verb} ${cat} for ${formatMonth(month)}`;
    if (row) {
      const next = input.mode === "add" ? row.assigned + amount : amount;
      s += ` (Assigned ${formatMilli(row.assigned)} → ${formatMilli(next)})`;
    }
    return s;
  },

  async move_money(input, ctx) {
    if (input.from_category_id === input.to_category_id) throw new ToolInputError("from and to must differ");
    const name = await categoryNamer(ctx);
    const month = normalizeMonth(input.month);
    return `Move ${money(parseMilli(input.amount))} from ${name(input.from_category_id)} → ${name(input.to_category_id)} (${formatMonth(month)})`;
  },

  async auto_assign(input, ctx) {
    const month = normalizeMonth(input.month);
    const mode = input.mode.replace(/_/g, " ");
    if (input.category_ids?.length) {
      const name = await categoryNamer(ctx);
      input.category_ids.forEach(name);
    }
    const preview = ctx.previewAutoAssign ? await ctx.previewAutoAssign(month, input.mode, input.category_ids) : null;
    const scope = input.category_ids?.length ? plural(input.category_ids.length, "selected category", "selected categories") : "all categories";
    return preview
      ? `Auto-assign (${mode}) for ${formatMonth(month)}: ${formatMilli(preview.total)} across ${plural(preview.categoryCount, "category", "categories")}`
      : `Auto-assign (${mode}) for ${formatMonth(month)}, ${scope}`;
  },

  async create_category(input) {
    return `Create category ${q(input.name.trim())} in ${input.group.trim()}`;
  },

  async update_target(input, ctx) {
    const name = await categoryNamer(ctx);
    const t = input.target;
    const parts: string[] = [t.type.replace(/_/g, " ")];
    if (t.type === "percent_of_income" && t.percent) parts.push(`${t.percent}% of income`);
    if (t.amount) parts.push(money(parseMilli(t.amount)));
    if (t.cadence && t.cadence !== "none") parts.push(t.cadence === "every_n_months" && t.cadence_every ? `every ${t.cadence_every} months` : t.cadence);
    if (t.target_date) parts.push(`by ${t.target_date}`);
    return `Set target for ${name(input.category_id)}: ${parts.join(", ")}`;
  },

  async remember(input) {
    return `Remember: ${q(input.fact.trim())}`;
  },
};

/** Validate a write tool call and build its human-readable diff (throws ToolInputError). */
export async function describeAction<K extends WriteToolName>(tool: K, input: WriteToolInput<K>, ctx: AiToolContext): Promise<string> {
  return (DIFFS[tool] as DiffBuilder<K>)(input, ctx);
}

export async function createPendingAction<K extends WriteToolName>(
  tool: K,
  input: WriteToolInput<K>,
  deps: { ctx: AiToolContext; store: PendingActionStore; now: () => Date; conversationId?: string; requestedBy?: string; toolUseId?: string },
): Promise<PendingAction<K>> {
  const humanDiff = await describeAction(tool, input, deps.ctx);
  const action: PendingAction<K> = {
    id: newId(),
    tool,
    input,
    humanDiff,
    status: "awaiting_confirmation",
    createdAt: deps.now().toISOString(),
    ...(deps.conversationId ? { conversationId: deps.conversationId } : {}),
    ...(deps.requestedBy ? { requestedBy: deps.requestedBy } : {}),
    ...(deps.toolUseId ? { toolUseId: deps.toolUseId } : {}),
  };
  await deps.store.save(action as PendingAction);
  return action;
}

export class PendingActionError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "not_pending" | "invalid_input",
  ) {
    super(message);
    this.name = "PendingActionError";
  }
}

export interface ExecuteConfirmedArgs {
  actionId: string;
  /** User who tapped Confirm. */
  confirmedBy: string;
  store: PendingActionStore;
  executor: ActionExecutor;
  audit: AuditSink;
  now?: () => Date;
  /** From the card's Edit flow; validated against the same schema. */
  editedInput?: unknown;
}

export type ExecuteConfirmedResult = { status: "confirmed"; action: PendingAction; result: ExecutedWrite } | { status: "failed"; action: PendingAction; error: string };

/**
 * Run a confirmed pending action through the injected executor. A confirmation applies to that
 * card only: the store's compare-and-set guarantees at most one execution.
 */
export async function executeConfirmedAction(args: ExecuteConfirmedArgs): Promise<ExecuteConfirmedResult> {
  const now = args.now ?? (() => new Date());
  const action = await args.store.get(args.actionId);
  if (!action) throw new PendingActionError(`Pending action ${args.actionId} not found`, "not_found");
  if (action.status !== "awaiting_confirmation") throw new PendingActionError(`Action is ${action.status}, not awaiting confirmation`, "not_pending");
  const schema = WRITE_TOOL_SCHEMAS[action.tool];
  const parsed = schema.safeParse(args.editedInput ?? action.input);
  if (!parsed.success) throw new PendingActionError(`Invalid input: ${parsed.error.message}`, "invalid_input");
  if (!(await args.store.transition(action.id, "awaiting_confirmation", "executing", { confirmedBy: args.confirmedBy }))) {
    throw new PendingActionError("Action was already confirmed or cancelled", "not_pending");
  }
  const run = args.executor[action.tool] as (input: unknown, meta: { actionId: string; confirmedBy: string }) => Promise<ExecutedWrite>;
  try {
    const result = await run(parsed.data, { actionId: action.id, confirmedBy: args.confirmedBy });
    await args.audit.record({
      at: now().toISOString(),
      userId: action.requestedBy ?? null,
      actor: "ai",
      confirmedBy: args.confirmedBy,
      action: `ai.${action.tool}`,
      entity: result.entity,
      entityId: result.entityId ?? null,
      before: result.before ?? null,
      after: result.after ?? (args.editedInput !== undefined ? { editedInput: parsed.data } : null),
    });
    await args.store.transition(action.id, "executing", "confirmed", { confirmedBy: args.confirmedBy });
    return { status: "confirmed", action: { ...action, status: "confirmed" }, result };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await args.store.transition(action.id, "executing", "failed", { error });
    return { status: "failed", action: { ...action, status: "failed" }, error };
  }
}

/** Cancel button. Returns false if the card was no longer pending. */
export async function rejectPendingAction(store: PendingActionStore, actionId: string, by: string): Promise<boolean> {
  return store.transition(actionId, "awaiting_confirmation", "rejected", { confirmedBy: by });
}

/** In-memory PendingActionStore for tests. */
export class InMemoryPendingActionStore implements PendingActionStore {
  readonly actions = new Map<string, PendingAction & { confirmedBy?: string; error?: string }>();
  async save(a: PendingAction): Promise<void> {
    this.actions.set(a.id, { ...a });
  }
  async get(id: string): Promise<PendingAction | null> {
    const a = this.actions.get(id);
    return a ? { ...a } : null;
  }
  async transition(id: string, from: PendingAction["status"], to: PendingAction["status"], patch?: { confirmedBy?: string; error?: string }): Promise<boolean> {
    const a = this.actions.get(id);
    if (!a || a.status !== from) return false;
    a.status = to;
    if (patch?.confirmedBy) a.confirmedBy = patch.confirmedBy;
    if (patch?.error) a.error = patch.error;
    return true;
  }
}

export class InMemoryAuditSink implements AuditSink {
  readonly entries: Parameters<AuditSink["record"]>[0][] = [];
  async record(e: Parameters<AuditSink["record"]>[0]): Promise<void> {
    this.entries.push(e);
  }
}
