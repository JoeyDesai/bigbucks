/**
 * Postgres implementations of the ai package's persistence interfaces (@homebase/db):
 * UsageSink → ai_usage, PendingActionStore → ai_tool_calls, AuditSink → audit_log,
 * AgentRecorder → ai_conversations / ai_messages / ai_tool_calls.
 *
 * ai_tool_calls.status only has auto | awaiting_confirmation | confirmed | rejected, so the extra
 * PendingAction states are encoded (see `encodeStatus`):
 *   executing = confirmed + confirmed_at NULL + error NULL
 *   confirmed = confirmed + confirmed_at set  + error NULL
 *   failed    = confirmed + error set
 */
import { and, desc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { schema as s, type Db } from "@homebase/db";
import { TZ, type Month } from "@homebase/shared";
import { jsonSafe } from "../json";
import { microUsdToUsdString, type UsageRecord, type UsageSink } from "../usage";
import type { AgentRecorder, AuditEntry, AuditSink, PendingAction, PendingActionStatus, PendingActionStore } from "../agent/context";
import type { WriteToolName } from "../agent/schemas";

// ---------------- ai_usage ----------------

export class DbUsageSink implements UsageSink {
  constructor(private readonly db: Db) {}

  async record(rec: UsageRecord): Promise<void> {
    await this.db.insert(s.aiUsage).values({
      at: new Date(rec.at),
      purpose: rec.purpose,
      model: rec.model,
      inputTokens: rec.inputTokens,
      outputTokens: rec.outputTokens,
      cacheReadTokens: rec.cacheReadTokens,
      cacheWriteTokens: rec.cacheWriteTokens,
      webSearches: rec.webSearches,
      costUsd: microUsdToUsdString(rec.costMicroUsd),
      userId: rec.userId ?? null,
      conversationId: rec.conversationId ?? null,
    });
  }

  /** Sum for the America/New_York calendar month, in micro-USD (exact: cost_usd is numeric(12,6)). */
  async monthToDateMicroUsd(month: Month): Promise<bigint> {
    const res = await this.db.execute<{ micro: bigint | string | null }>(sql`
      SELECT coalesce(sum(round(cost_usd * 1000000)), 0)::bigint AS micro FROM ${s.aiUsage}
      WHERE at >= (${month}::date::timestamp AT TIME ZONE ${TZ})
        AND at < ((${month}::date + interval '1 month')::timestamp AT TIME ZONE ${TZ})`);
    const v = res.rows[0]?.micro ?? 0n;
    return typeof v === "bigint" ? v : BigInt(v);
  }
}

// ---------------- ai_tool_calls (pending actions) ----------------

type DbToolStatus = (typeof s.aiToolCalls.$inferSelect)["status"];

function statusPredicate(st: PendingActionStatus): SQL {
  const t = s.aiToolCalls;
  switch (st) {
    case "awaiting_confirmation":
      return eq(t.status, "awaiting_confirmation");
    case "rejected":
      return eq(t.status, "rejected");
    case "executing":
      return and(eq(t.status, "confirmed"), isNull(t.confirmedAt), isNull(t.error))!;
    case "confirmed":
      return and(eq(t.status, "confirmed"), isNotNull(t.confirmedAt), isNull(t.error))!;
    case "failed":
      return and(eq(t.status, "confirmed"), isNotNull(t.error))!;
  }
}

function decodeStatus(r: { status: DbToolStatus; confirmedAt: Date | null; error: string | null }): PendingActionStatus {
  if (r.status === "confirmed") return r.error ? "failed" : r.confirmedAt ? "confirmed" : "executing";
  if (r.status === "rejected") return "rejected";
  return "awaiting_confirmation";
}

export interface DbPendingActionStoreOptions {
  /** Called on save to link the row to the assistant message that proposed it. */
  currentMessageId?: () => string | null;
}

export class DbPendingActionStore implements PendingActionStore {
  constructor(
    private readonly db: Db,
    private readonly opts: DbPendingActionStoreOptions = {},
  ) {}

  async save(a: PendingAction): Promise<void> {
    if (!a.conversationId) throw new Error("pending actions need a conversationId (ai_tool_calls.conversation_id is required)");
    await this.db.insert(s.aiToolCalls).values({
      id: a.id,
      conversationId: a.conversationId,
      messageId: this.opts.currentMessageId?.() ?? null,
      toolUseId: a.toolUseId ?? null,
      name: a.tool,
      input: jsonSafe(a.input),
      outputSummary: a.humanDiff,
      status: "awaiting_confirmation",
      createdAt: new Date(a.createdAt),
    });
  }

  async get(id: string): Promise<PendingAction | null> {
    const [r] = await this.db
      .select({ c: s.aiToolCalls, userId: s.aiConversations.userId })
      .from(s.aiToolCalls)
      .innerJoin(s.aiConversations, eq(s.aiConversations.id, s.aiToolCalls.conversationId))
      .where(eq(s.aiToolCalls.id, id))
      .limit(1);
    if (!r || r.c.status === "auto") return null;
    return {
      id: r.c.id,
      tool: r.c.name as WriteToolName,
      input: r.c.input as never,
      humanDiff: r.c.outputSummary ?? "",
      status: decodeStatus(r.c),
      createdAt: r.c.createdAt.toISOString(),
      conversationId: r.c.conversationId,
      ...(r.userId ? { requestedBy: r.userId } : {}),
      ...(r.c.toolUseId ? { toolUseId: r.c.toolUseId } : {}),
    };
  }

  /** Compare-and-set via a conditional UPDATE: at most one caller wins each transition. */
  async transition(id: string, from: PendingActionStatus, to: PendingActionStatus, patch: { confirmedBy?: string; error?: string } = {}): Promise<boolean> {
    const set: Partial<typeof s.aiToolCalls.$inferInsert> = {};
    switch (to) {
      case "awaiting_confirmation":
        Object.assign(set, { status: "awaiting_confirmation", confirmedAt: null, error: null });
        break;
      case "rejected":
        Object.assign(set, { status: "rejected", error: null });
        break;
      case "executing":
        Object.assign(set, { status: "confirmed", confirmedAt: null, error: null });
        break;
      case "confirmed":
        Object.assign(set, { status: "confirmed", confirmedAt: new Date(), error: null });
        break;
      case "failed":
        Object.assign(set, { status: "confirmed", confirmedAt: new Date(), error: patch.error ?? "failed" });
        break;
    }
    if (patch.confirmedBy) set.confirmedBy = patch.confirmedBy;
    const rows = await this.db
      .update(s.aiToolCalls)
      .set(set)
      .where(and(eq(s.aiToolCalls.id, id), statusPredicate(from)))
      .returning({ id: s.aiToolCalls.id });
    return rows.length === 1;
  }
}

// ---------------- audit_log ----------------

export class DbAuditSink implements AuditSink {
  constructor(private readonly db: Db) {}
  async record(e: AuditEntry): Promise<void> {
    await this.db.insert(s.auditLog).values({
      at: new Date(e.at),
      userId: e.userId,
      actor: e.actor,
      confirmedBy: e.confirmedBy,
      action: e.action,
      entity: e.entity,
      entityId: e.entityId,
      before: e.before === undefined ? null : jsonSafe(e.before),
      after: e.after === undefined ? null : jsonSafe(e.after),
    });
  }
}

// ---------------- conversations / messages / tool calls ----------------

export async function createConversation(db: Db, opts: { userId: string | null; title?: string | null }): Promise<string> {
  const [r] = await db
    .insert(s.aiConversations)
    .values({ userId: opts.userId, title: opts.title ?? null })
    .returning({ id: s.aiConversations.id });
  return r!.id;
}

/** Load a conversation's messages in order, in the shape runAgent() takes as `history`. */
export async function loadConversationHistory(db: Db, conversationId: string): Promise<{ role: "user" | "assistant"; content: unknown }[]> {
  const rows = await db
    .select({ role: s.aiMessages.role, content: s.aiMessages.content })
    .from(s.aiMessages)
    .where(eq(s.aiMessages.conversationId, conversationId))
    .orderBy(s.aiMessages.createdAt, s.aiMessages.id);
  return rows;
}

/**
 * Persists every message and tool call of one agent turn. Use `pendingActionStore()` for the
 * same turn so write-tool rows are linked to the assistant message that proposed them; the
 * recorder doesn't insert a second row for those (status awaiting_confirmation).
 */
export class DbAgentRecorder implements AgentRecorder {
  private lastAssistantMessageId: string | null = null;

  constructor(
    private readonly db: Db,
    readonly conversationId: string,
  ) {}

  pendingActionStore(): DbPendingActionStore {
    return new DbPendingActionStore(this.db, { currentMessageId: () => this.lastAssistantMessageId });
  }

  async onMessage(m: { role: "user" | "assistant"; content: unknown; model?: string; inputTokens?: number; outputTokens?: number; costMicroUsd?: bigint }): Promise<void> {
    const [r] = await this.db
      .insert(s.aiMessages)
      .values({
        conversationId: this.conversationId,
        role: m.role,
        content: jsonSafe(typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content) as object,
        model: m.model ?? null,
        inputTokens: m.inputTokens ?? null,
        outputTokens: m.outputTokens ?? null,
        costUsd: m.costMicroUsd !== undefined ? microUsdToUsdString(m.costMicroUsd) : null,
      })
      .returning({ id: s.aiMessages.id });
    if (m.role === "assistant") this.lastAssistantMessageId = r!.id;
    await this.db.update(s.aiConversations).set({ updatedAt: new Date() }).where(eq(s.aiConversations.id, this.conversationId));
  }

  async onToolCall(c: { toolUseId: string; name: string; input: unknown; outputSummary: string; status: "auto" | "awaiting_confirmation" | "error" }): Promise<void> {
    if (c.status === "awaiting_confirmation") {
      // Row already written by the pending-action store; make sure it's linked to the message.
      if (this.lastAssistantMessageId) {
        await this.db
          .update(s.aiToolCalls)
          .set({ messageId: this.lastAssistantMessageId })
          .where(and(eq(s.aiToolCalls.conversationId, this.conversationId), eq(s.aiToolCalls.toolUseId, c.toolUseId), isNull(s.aiToolCalls.messageId)));
      }
      return;
    }
    await this.db.insert(s.aiToolCalls).values({
      conversationId: this.conversationId,
      messageId: this.lastAssistantMessageId,
      toolUseId: c.toolUseId,
      name: c.name,
      input: jsonSafe(c.input ?? {}) as object,
      outputSummary: c.outputSummary,
      status: "auto",
      error: c.status === "error" ? c.outputSummary : null,
    });
  }
}

/** Most recent pending (awaiting confirmation) actions for a conversation, newest first. */
export async function listPendingActions(db: Db, conversationId: string): Promise<string[]> {
  const rows = await db
    .select({ id: s.aiToolCalls.id })
    .from(s.aiToolCalls)
    .where(and(eq(s.aiToolCalls.conversationId, conversationId), eq(s.aiToolCalls.status, "awaiting_confirmation")))
    .orderBy(desc(s.aiToolCalls.createdAt));
  return rows.map((r) => r.id);
}
