/**
 * Client side of POST /api/ask: an incremental SSE parser and a reducer that folds AgentEvents into
 * the streaming assistant turn. Pure, unit-tested.
 */
import { WRITE_TOOL_SET, type ActionVM, type AskTurnVM } from "./types";

export interface SseMessage {
  event: string;
  data: string;
}

/** Feed decoded text; returns complete messages and the unconsumed remainder. */
export function parseSse(buffer: string): { messages: SseMessage[]; rest: string } {
  const messages: SseMessage[] = [];
  const norm = buffer.replace(/\r\n/g, "\n");
  const chunks = norm.split("\n\n");
  const rest = chunks.pop() ?? "";
  for (const c of chunks) {
    let event = "message";
    const data: string[] = [];
    for (const line of c.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length) messages.push({ event, data: data.join("\n") });
  }
  return { messages, rest };
}

/** The subset of AgentEvent fields the client uses (bigints arrive as strings). */
export type ClientEvent =
  | { type: "conversation"; id: string; created: boolean }
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; summary: string; isError: boolean }
  | { type: "chart"; id: string; spec: import("@homebase/ai").ChartSpec }
  | { type: "pending_action"; action: { id: string; tool: string; input: Record<string, unknown>; humanDiff: string; status: ActionVM["status"] } }
  | { type: "error"; code: string; message: string }
  | { type: "done"; stopReason: string; text: string; speech: string; usage: { costMicroUsd: string } };

export function reduceTurn(turn: AskTurnVM, e: ClientEvent): AskTurnVM {
  const parts = [...turn.parts];
  switch (e.type) {
    case "text_delta": {
      const last = parts[parts.length - 1];
      if (last?.type === "text") parts[parts.length - 1] = { type: "text", text: last.text + e.text };
      else parts.push({ type: "text", text: e.text });
      return { ...turn, parts };
    }
    case "tool_call":
      if (e.name === "render_chart" || WRITE_TOOL_SET.has(e.name)) return turn;
      return { ...turn, parts: [...parts, { type: "tool", id: e.id, name: e.name, done: false }] };
    case "tool_result": {
      const i = parts.findIndex((p) => p.type === "tool" && p.id === e.id);
      if (i === -1) return turn;
      parts[i] = { type: "tool", id: e.id, name: e.name, done: true, summary: e.summary, isError: e.isError };
      return { ...turn, parts };
    }
    case "chart":
      return { ...turn, parts: [...parts, { type: "chart", id: e.id, spec: e.spec }] };
    case "pending_action":
      return { ...turn, parts: [...parts, { type: "action", action: { id: e.action.id, tool: e.action.tool, humanDiff: e.action.humanDiff, status: e.action.status, input: e.action.input } }] };
    case "error":
      return { ...turn, error: e.message };
    case "done": {
      // Drop whitespace-only text parts left between tool calls.
      const cleaned = parts.filter((p) => p.type !== "text" || p.text.trim() !== "").map((p) => (p.type === "text" ? { ...p, text: p.text.trim() } : p));
      return { ...turn, parts: cleaned, streaming: false, ...(e.speech ? { speech: e.speech } : {}) };
    }
    default:
      return turn;
  }
}
