/**
 * Persisted conversation → Ask view models (pure, unit-tested), and history repair before the
 * history is sent back to the model.
 */
import { ChartSpecSchema, SpeechExtractor, cleanSpeech, isWriteTool, speechFromMarkdown, type PendingActionStatus } from "@homebase/ai";
import type { ActionVM, AskTurnVM } from "@/components/ask/types";

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: unknown;
}

export interface StoredToolCall {
  id: string;
  toolUseId: string | null;
  name: string;
  input: unknown;
  outputSummary: string | null;
  status: PendingActionStatus | "auto";
  error: string | null;
}

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string };
const blocks = (c: unknown): Block[] => (typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? (c as Block[]) : []);

/** Split the stored assistant text into visible markdown and the <speech> summary. */
export function splitSpeech(text: string): { visible: string; speech: string | null } {
  const x = new SpeechExtractor();
  const visible = x.push(text) + x.flush();
  return { visible, speech: x.hasSpeech ? cleanSpeech(x.speech) : null };
}

export function toActionVM(c: StoredToolCall): ActionVM | null {
  if (c.status === "auto" || !isWriteTool(c.name)) return null;
  return {
    id: c.id,
    tool: c.name,
    humanDiff: c.outputSummary ?? c.name,
    status: c.status,
    input: (c.input && typeof c.input === "object" ? c.input : {}) as Record<string, unknown>,
    ...(c.error ? { error: c.error } : {}),
  };
}

/**
 * One UI turn per user text message, and one assistant turn for everything the model produced
 * until the next user text (several API messages when tools ran).
 */
export function messagesToTurns(messages: StoredMessage[], toolCalls: StoredToolCall[]): AskTurnVM[] {
  const byToolUse = new Map(toolCalls.filter((c) => c.toolUseId).map((c) => [c.toolUseId!, c]));
  const turns: AskTurnVM[] = [];
  let current: AskTurnVM | null = null;
  for (const m of messages) {
    const bs = blocks(m.content);
    if (m.role === "user") {
      const text = bs
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text!)
        .join("\n")
        .trim();
      const onlyToolResults = bs.length > 0 && bs.every((b) => b.type === "tool_result" || (b.type === "text" && /^Tool limit reached/.test(b.text ?? "")));
      if (!text || onlyToolResults) continue;
      current = null;
      turns.push({ id: m.id, role: "user", parts: [{ type: "text", text }] });
      continue;
    }
    if (!current) {
      current = { id: m.id, role: "assistant", parts: [] };
      turns.push(current);
    }
    for (const b of bs) {
      if (b.type === "text" && b.text) {
        const { visible, speech } = splitSpeech(b.text);
        if (visible.trim()) current.parts.push({ type: "text", text: visible.trim() });
        if (speech) current.speech = speech;
      } else if (b.type === "tool_use" && b.name) {
        if (b.name === "render_chart") {
          const spec = ChartSpecSchema.safeParse((b.input as { spec?: unknown } | undefined)?.spec);
          if (spec.success) current.parts.push({ type: "chart", id: b.id ?? `${m.id}-chart`, spec: spec.data });
        } else if (isWriteTool(b.name)) {
          const call = b.id ? byToolUse.get(b.id) : undefined;
          const vm = call ? toActionVM(call) : null;
          if (vm) current.parts.push({ type: "action", action: vm });
        } else {
          const call = b.id ? byToolUse.get(b.id) : undefined;
          current.parts.push({ type: "tool", id: b.id ?? `${m.id}-${b.name}`, name: b.name, done: true, ...(call?.outputSummary ? { summary: call.outputSummary } : {}), ...(call?.error ? { isError: true } : {}) });
        }
      }
    }
  }
  for (const t of turns) {
    if (t.role === "assistant" && !t.speech) {
      const md = t.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");
      if (md) t.speech = speechFromMarkdown(md);
    }
  }
  return turns;
}

/**
 * Make persisted history valid for the Messages API: every assistant tool_use needs a tool_result
 * in the next user message (an interrupted turn can leave one dangling), and the history must not
 * end with an assistant tool_use.
 */
export function repairHistory<T extends { role: "user" | "assistant"; content: unknown }>(history: T[]): { role: "user" | "assistant"; content: unknown }[] {
  const out: { role: "user" | "assistant"; content: unknown }[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    out.push({ role: m.role, content: m.content });
    if (m.role !== "assistant") continue;
    const uses = blocks(m.content).filter((b) => b.type === "tool_use" && b.id);
    if (!uses.length) continue;
    const next = history[i + 1];
    const answered = new Set(next && next.role === "user" ? blocks(next.content).filter((b) => b.type === "tool_result").map((b) => b.tool_use_id) : []);
    const missing = uses.filter((u) => !answered.has(u.id));
    if (!missing.length) continue;
    const results = missing.map((u) => ({ type: "tool_result", tool_use_id: u.id, content: "Not run: the turn was interrupted", is_error: true }));
    if (next && next.role === "user") {
      // Merge into the next user message; tool_result blocks must come first.
      const nb = blocks(next.content);
      out.push({ role: "user", content: [...nb.filter((b) => b.type === "tool_result"), ...results, ...nb.filter((b) => b.type !== "tool_result")] });
      i++;
    } else {
      out.push({ role: "user", content: results });
    }
  }
  return out;
}
