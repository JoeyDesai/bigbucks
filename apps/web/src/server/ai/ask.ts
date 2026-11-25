import "server-only";
/**
 * One Ask turn as a Server-Sent Events stream (§11.2): create the conversation if needed, load and
 * repair its history, run the agent with DB persistence, and frame every AgentEvent.
 */
import { listMemory, listUsers } from "@homebase/core";
import { runAgent, toSseFrame, type AgentEvent, type AiClient, type BetaMessageParam } from "@homebase/ai";
import { createConversation, DbAgentRecorder, loadConversationHistory } from "@homebase/ai/db";
import { getSetting } from "@homebase/core";
import type { Db } from "@homebase/db";
import { log } from "@/server/log";
import { createAiToolContext, listAccountRefs, listCategoryRefs } from "./context";
import { repairHistory } from "./thread";

export const NO_KEY_MESSAGE = "Add an Anthropic API key in Settings → AI to use Ask.";

export interface AskTurnInput {
  db: Db;
  ai: AiClient | null;
  speaker: { id: string; name: string };
  conversationId: string | null;
  message: string;
  deep: boolean;
  signal?: AbortSignal;
  now?: Date;
}

/** Extra frame types the route sends besides AgentEvents. */
export type AskFrame = AgentEvent | { type: "conversation"; id: string; created: boolean };

export function sseFrame(e: AskFrame): string {
  if (e.type === "conversation") return `event: conversation\ndata: ${JSON.stringify(e)}\n\n`;
  return toSseFrame(e);
}

function titleFrom(message: string): string {
  const t = message.replace(/\s+/g, " ").trim();
  return t.length > 70 ? `${t.slice(0, 67).trimEnd()}…` : t;
}

/** The frames of one turn, in order. The route turns them into a ReadableStream. */
export async function* askTurn(input: AskTurnInput): AsyncGenerator<AskFrame> {
  const { db } = input;
  if (!input.ai) {
    yield { type: "error", code: "disabled", message: NO_KEY_MESSAGE };
    yield { type: "done", stopReason: "disabled", text: "", speech: "", toolIterations: 0, requests: 0, newMessages: [], pendingActionIds: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costMicroUsd: 0n } };
    return;
  }
  let conversationId = input.conversationId;
  const created = !conversationId;
  if (!conversationId) conversationId = await createConversation(db, { userId: input.speaker.id, title: titleFrom(input.message) });
  yield { type: "conversation", id: conversationId, created };

  const history = created ? [] : (repairHistory(await loadConversationHistory(db, conversationId)) as BetaMessageParam[]);
  const recorder = new DbAgentRecorder(db, conversationId);
  const budget = await getSetting(db, "ai_budget");
  const [memory, categories, accounts, users] = [await listMemory(db), await listCategoryRefs(db), await listAccountRefs(db), await listUsers(db)];

  const gen = runAgent({
    ai: input.ai,
    ctx: createAiToolContext(db, { userId: input.speaker.id, webLookupEnabled: budget.web_lookup_enabled }),
    actions: recorder.pendingActionStore(),
    recorder,
    conversationId,
    prompt: {
      now: input.now ?? new Date(),
      speaker: input.speaker,
      householdMemory: memory.map((m) => m.text),
      categories,
      accounts,
    },
    history,
    userMessage: input.message,
    deep: input.deep,
    webQueryPolicy: { householdNames: users.map((u) => u.displayName) },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  try {
    for await (const ev of gen) yield ev;
  } catch (e) {
    log.error({ err: e instanceof Error ? e.message : String(e), conversationId }, "ask turn failed");
    yield { type: "error", code: "error", message: "Something went wrong while answering. Try again." };
  }
}

/** Frames → a byte stream for `new Response(stream, { headers: SSE_HEADERS })`. */
export function framesToStream(frames: AsyncGenerator<AskFrame>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await frames.next();
        if (done) controller.close();
        else controller.enqueue(enc.encode(sseFrame(value)));
      } catch (e) {
        controller.enqueue(enc.encode(sseFrame({ type: "error", code: "error", message: e instanceof Error ? e.message : "Request failed" })));
        controller.close();
      }
    },
    async cancel() {
      await frames.return(undefined);
    },
  });
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;
