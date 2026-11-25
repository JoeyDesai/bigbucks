/**
 * §11.2 agent loop: a manual, streaming tool loop capped at 12 tool iterations per turn, exposed
 * as an async generator of events suitable for SSE (`POST /api/ask`).
 *
 * - Read tools run automatically; their results are redacted and dollar-formatted.
 * - Write tools NEVER execute here: they produce a pending action card (see actions.ts).
 * - When the cap is hit, one final request with tool_choice "none" asks the model to answer
 *   with what it has.
 */
import Anthropic from "@anthropic-ai/sdk";
import { AiCapExceededError, AiDisabledError, type AiClient, type BetaMessage, type BetaMessageParam, type BetaStreamParams, type BetaToolResultBlockParam, type BetaToolUseBlock, type BetaContentBlockParam } from "../client";
import type { WebQueryPolicy } from "../redact";
import type { AgentRecorder, AiToolContext, PendingAction, PendingActionStore } from "./context";
import type { ChartSpec } from "./chart";
import { buildAgentSystem, type AgentPromptContext } from "./systemPrompt";
import { toolDefinitions, runReadTool } from "./tools";
import { createPendingAction, ToolInputError } from "./actions";
import { READ_TOOL_SCHEMAS, WRITE_TOOL_SCHEMAS, isReadTool, isWriteTool } from "./schemas";
import { SpeechExtractor, cleanSpeech, speechFromMarkdown } from "./speech";

export const MAX_TOOL_ITERATIONS = 12;
/** Absolute ceiling on model requests per turn (covers pause_turn and JSON retries). */
const MAX_REQUESTS_PER_TURN = MAX_TOOL_ITERATIONS + 6;

export type AgentStopReason = "end_turn" | "iteration_cap" | "max_tokens" | "refusal" | "cap_exceeded" | "disabled" | "error" | "aborted";

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; summary: string; isError: boolean }
  | { type: "chart"; id: string; spec: ChartSpec }
  | { type: "pending_action"; action: PendingAction }
  | { type: "error"; code: AgentStopReason; message: string }
  | {
      type: "done";
      stopReason: AgentStopReason;
      /** Visible markdown reply (speech tag removed). */
      text: string;
      /** Short spoken summary for TTS (no markdown). */
      speech: string;
      toolIterations: number;
      requests: number;
      /** Messages appended this turn (user message, assistant turns, tool results) for persistence. */
      newMessages: BetaMessageParam[];
      pendingActionIds: string[];
      usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costMicroUsd: bigint };
    };

export interface RunAgentOptions {
  ai: AiClient;
  ctx: AiToolContext;
  actions: PendingActionStore;
  prompt: Omit<AgentPromptContext, "deep">;
  /** Prior conversation (as persisted in ai_messages). */
  history: BetaMessageParam[];
  userMessage: string;
  deep?: boolean;
  recorder?: AgentRecorder;
  conversationId?: string;
  maxIterations?: number;
  maxTokens?: number;
  webQueryPolicy?: WebQueryPolicy;
  signal?: AbortSignal;
}

function errorText(e: unknown): string {
  if (e instanceof ToolInputError) return e.message;
  if (e instanceof Error) return `Tool failed: ${e.message}`;
  return "Tool failed";
}

export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<AgentEvent, void, undefined> {
  const { ai, ctx } = opts;
  const maxIterations = opts.maxIterations ?? MAX_TOOL_ITERATIONS;
  const model = opts.deep ? ai.models.deep : ai.models.chat;
  const newMessages: BetaMessageParam[] = [];
  const pendingActionIds: string[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costMicroUsd: 0n };
  const speech = new SpeechExtractor();
  let visibleText = "";
  let toolIterations = 0;
  let requests = 0;

  const finish = (stopReason: AgentStopReason): AgentEvent => {
    visibleText += speech.flush();
    const spoken = speech.hasSpeech ? cleanSpeech(speech.speech) : speechFromMarkdown(visibleText);
    return { type: "done", stopReason, text: visibleText.trim(), speech: spoken, toolIterations, requests, newMessages, pendingActionIds, usage };
  };

  try {
    await ai.assertAvailable("chat");
  } catch (e) {
    const code: AgentStopReason = e instanceof AiCapExceededError ? "cap_exceeded" : e instanceof AiDisabledError ? "disabled" : "error";
    const message = code === "cap_exceeded" ? "This month's AI budget is used up, so chat is paused until next month (you can raise the cap in Settings)." : "AI chat is turned off in Settings.";
    yield { type: "error", code, message };
    yield finish(code);
    return;
  }

  const system = buildAgentSystem({ ...opts.prompt, deep: opts.deep ?? false });
  const tools = toolDefinitions();
  const userMsg: BetaMessageParam = { role: "user", content: opts.userMessage };
  const messages: BetaMessageParam[] = [...opts.history, userMsg];
  newMessages.push(userMsg);
  await opts.recorder?.onMessage?.({ role: "user", content: opts.userMessage });

  let wrapUp = false; // set after the iteration cap: final answer without tools
  let jsonRetries = 0;

  while (requests < MAX_REQUESTS_PER_TURN) {
    if (opts.signal?.aborted) {
      yield finish("aborted");
      return;
    }
    const params: BetaStreamParams = ai.withRefusalFallback({
      model,
      max_tokens: opts.maxTokens ?? 16_000,
      system,
      tools,
      messages: [...messages],
      cache_control: { type: "ephemeral" }, // auto-cache the growing conversation prefix
      output_config: { effort: opts.deep ? "high" : "medium" },
      ...(wrapUp ? { tool_choice: { type: "none" as const } } : {}),
    });
    requests++;
    let msg: BetaMessage;
    try {
      const stream = ai.anthropic.beta.messages.stream(params, opts.signal ? { signal: opts.signal } : undefined);
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          const visible = speech.push(ev.delta.text);
          if (visible) {
            visibleText += visible;
            yield { type: "text_delta", text: visible };
          }
        }
      }
      msg = await stream.finalMessage();
      jsonRetries = 0;
    } catch (e) {
      if (opts.signal?.aborted) {
        yield finish("aborted");
        return;
      }
      // Eager input streaming: an unparseable tool input rejects the stream. Re-issue the turn
      // (bounded); API errors are surfaced, never retried here (the SDK already retried them).
      if (!(e instanceof Anthropic.APIError) && jsonRetries++ < 2) continue;
      yield { type: "error", code: "error", message: e instanceof Error ? e.message : "Request failed" };
      yield finish("error");
      return;
    }

    const rec = await ai.recordUsage("chat", msg.model || model, msg.usage, {
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
      userId: opts.prompt.speaker.id,
    });
    usage.inputTokens += rec.inputTokens;
    usage.outputTokens += rec.outputTokens;
    usage.cacheReadTokens += rec.cacheReadTokens;
    usage.costMicroUsd += rec.costMicroUsd;

    const assistant: BetaMessageParam = { role: "assistant", content: msg.content as BetaContentBlockParam[] };
    messages.push(assistant);
    newMessages.push(assistant);
    await opts.recorder?.onMessage?.({ role: "assistant", content: msg.content, model: msg.model || model, inputTokens: rec.inputTokens, outputTokens: rec.outputTokens, costMicroUsd: rec.costMicroUsd });

    if (msg.stop_reason === "pause_turn") continue;
    if (msg.stop_reason === "refusal") {
      yield { type: "error", code: "refusal", message: "I can't help with that request." };
      yield finish("refusal");
      return;
    }
    const toolUses = msg.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
    // Keep persisted history valid: every tool_use needs a tool_result, even when not run.
    const closeUnanswered = (why: string) => {
      if (toolUses.length === 0) return;
      const closing: BetaMessageParam = {
        role: "user",
        content: toolUses.map((tu): BetaToolResultBlockParam => ({ type: "tool_result", tool_use_id: tu.id, content: `Not run: ${why}`, is_error: true })),
      };
      messages.push(closing);
      newMessages.push(closing);
    };
    if (msg.stop_reason === "max_tokens") {
      // A truncated tool input could still validate; never run tools from a truncated turn.
      closeUnanswered("response was cut off");
      yield finish("max_tokens");
      return;
    }
    if (toolUses.length === 0 || msg.stop_reason !== "tool_use" || wrapUp) {
      closeUnanswered("tool limit reached");
      yield finish(wrapUp ? "iteration_cap" : "end_turn");
      return;
    }

    toolIterations++;
    const results: BetaToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      yield { type: "tool_call", id: tu.id, name: tu.name, input: tu.input };
      let content: string;
      let summary: string;
      let isError = false;
      let status: "auto" | "awaiting_confirmation" | "error" = "auto";
      try {
        if (isReadTool(tu.name)) {
          const parsed = READ_TOOL_SCHEMAS[tu.name].safeParse(tu.input);
          if (!parsed.success) throw new ToolInputError(`Invalid input: ${parsed.error.message}`);
          const out = await runReadTool(tu.name, parsed.data as never, { ctx, ai, ...(opts.webQueryPolicy ? { webQueryPolicy: opts.webQueryPolicy } : {}) });
          content = out.content;
          summary = out.summary;
          if (out.chart) yield { type: "chart", id: tu.id, spec: out.chart };
        } else if (isWriteTool(tu.name)) {
          const parsed = WRITE_TOOL_SCHEMAS[tu.name].safeParse(tu.input);
          if (!parsed.success) throw new ToolInputError(`Invalid input: ${parsed.error.message}`);
          const action = await createPendingAction(tu.name, parsed.data as never, {
            ctx,
            store: opts.actions,
            now: ai.now,
            ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
            requestedBy: opts.prompt.speaker.id,
            toolUseId: tu.id,
          });
          pendingActionIds.push(action.id);
          yield { type: "pending_action", action };
          status = "awaiting_confirmation";
          summary = action.humanDiff;
          content = JSON.stringify({
            status: "awaiting_user_confirmation",
            action_id: action.id,
            card: action.humanDiff,
            note: "Nothing has changed yet. The user must tap Confirm on the card. Tell them it is ready to confirm.",
          });
        } else {
          throw new ToolInputError(`Unknown tool ${tu.name}`);
        }
      } catch (e) {
        isError = true;
        status = "error";
        content = errorText(e);
        summary = content;
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content, ...(isError ? { is_error: true } : {}) });
      yield { type: "tool_result", id: tu.id, name: tu.name, summary, isError };
      await opts.recorder?.onToolCall?.({ toolUseId: tu.id, name: tu.name, input: tu.input, outputSummary: summary, status });
    }

    const userContent: BetaContentBlockParam[] = [...results];
    if (toolIterations >= maxIterations) {
      wrapUp = true;
      userContent.push({ type: "text", text: `Tool limit reached (${maxIterations} steps). Answer now with what you have, and say what you could not check.` });
    }
    const toolMsg: BetaMessageParam = { role: "user", content: userContent };
    messages.push(toolMsg);
    newMessages.push(toolMsg);
    await opts.recorder?.onMessage?.({ role: "user", content: userContent });
  }
  yield finish(wrapUp ? "iteration_cap" : "error");
}

/** Collect a full run (tests, non-streaming callers). */
export async function collectAgentRun(gen: AsyncGenerator<AgentEvent>): Promise<{ events: AgentEvent[]; done: Extract<AgentEvent, { type: "done" }> }> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  const done = events.find((e): e is Extract<AgentEvent, { type: "done" }> => e.type === "done");
  if (!done) throw new Error("agent run ended without a done event");
  return { events, done };
}

/** Serialize an event for Server-Sent Events (bigint-safe). */
export function toSseFrame(e: AgentEvent): string {
  const data = JSON.stringify(e, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  return `event: ${e.type}\ndata: ${data}\n\n`;
}
