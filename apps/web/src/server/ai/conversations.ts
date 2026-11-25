import "server-only";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { aiConversations, aiMessages, aiToolCalls, type Db } from "@homebase/db";
import type { PendingActionStatus } from "@homebase/ai";
import type { AskTurnVM, ConversationListItem } from "@/components/ask/types";
import { messagesToTurns, splitSpeech, type StoredToolCall } from "./thread";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Conversations visible to a user: their own, plus system ones (the weekly digest has no user). */
export async function listConversations(db: Db, userId: string | null, limit = 50): Promise<ConversationListItem[]> {
  const res = await db.execute<{ id: string; title: string | null; updated_at: Date; preview: string | null }>(sql`
    SELECT c.id, c.title, c.updated_at,
      (SELECT left(coalesce(m.content->0->>'text', ''), 160) FROM ai_messages m WHERE m.conversation_id = c.id AND m.role = 'assistant'
        AND m.content->0->>'type' = 'text' ORDER BY m.created_at DESC LIMIT 1) AS preview
    FROM ai_conversations c
    WHERE c.archived_at IS NULL AND (c.user_id IS NULL OR ${userId ? sql`c.user_id = ${userId}` : sql`FALSE`})
      AND EXISTS (SELECT 1 FROM ai_messages m WHERE m.conversation_id = c.id)
    ORDER BY c.updated_at DESC
    LIMIT ${limit}`);
  return res.rows.map((r) => ({
    id: r.id,
    title: r.title?.trim() || "Untitled chat",
    updatedAt: new Date(r.updated_at).toISOString(),
    preview: r.preview ? splitSpeech(r.preview).visible.replace(/[#*_`>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 120) : "",
  }));
}

export async function getConversation(db: Db, id: string): Promise<{ id: string; userId: string | null; title: string | null } | null> {
  if (!UUID.test(id)) return null;
  const [c] = await db
    .select({ id: aiConversations.id, userId: aiConversations.userId, title: aiConversations.title })
    .from(aiConversations)
    .where(and(eq(aiConversations.id, id), isNull(aiConversations.archivedAt)));
  return c ?? null;
}

export function canAccessConversation(c: { userId: string | null }, userId: string | null): boolean {
  return c.userId === null || c.userId === userId;
}

function decodeStatus(r: { status: "auto" | "awaiting_confirmation" | "confirmed" | "rejected"; confirmedAt: Date | null; error: string | null }): PendingActionStatus | "auto" {
  if (r.status === "auto") return "auto";
  if (r.status === "confirmed") return r.error ? "failed" : r.confirmedAt ? "confirmed" : "executing";
  return r.status;
}

export async function loadThread(db: Db, conversationId: string): Promise<AskTurnVM[]> {
  const msgs = await db
    .select({ id: aiMessages.id, role: aiMessages.role, content: aiMessages.content })
    .from(aiMessages)
    .where(eq(aiMessages.conversationId, conversationId))
    .orderBy(asc(aiMessages.createdAt), asc(aiMessages.id));
  const calls = await db
    .select({ id: aiToolCalls.id, toolUseId: aiToolCalls.toolUseId, name: aiToolCalls.name, input: aiToolCalls.input, outputSummary: aiToolCalls.outputSummary, status: aiToolCalls.status, confirmedAt: aiToolCalls.confirmedAt, error: aiToolCalls.error })
    .from(aiToolCalls)
    .where(eq(aiToolCalls.conversationId, conversationId))
    .orderBy(desc(aiToolCalls.createdAt));
  const stored: StoredToolCall[] = calls.map((c) => ({ id: c.id, toolUseId: c.toolUseId, name: c.name, input: c.input, outputSummary: c.outputSummary, status: decodeStatus(c), error: c.error }));
  return messagesToTurns(
    msgs.map((m) => ({ id: m.id, role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    stored,
  );
}

export async function archiveConversation(db: Db, id: string): Promise<void> {
  await db.update(aiConversations).set({ archivedAt: new Date() }).where(eq(aiConversations.id, id));
}
