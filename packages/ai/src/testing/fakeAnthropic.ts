/**
 * Fake Anthropic client for tests: no network. Responses are scripted (a queue or a function of
 * the request). `stream()` replays the scripted message as SSE-style events in small chunks.
 */
import type {
  AnthropicLike,
  BetaBatchCreateParams,
  BetaBatchResult,
  BetaContentBlock,
  BetaCreateParams,
  BetaMessage,
  BetaMessageBatch,
  BetaStreamEvent,
  BetaStreamParams,
  MessageStreamLike,
} from "../client";

export type FakeResponse = BetaMessage | Error;
export type FakeResponder = (params: BetaStreamParams, callIndex: number) => FakeResponse;

export interface FakeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  web_search_requests?: number;
}

let idCounter = 0;
const nextId = (p: string) => `${p}_${(++idCounter).toString(36).padStart(6, "0")}`;

export function textBlock(text: string): BetaContentBlock {
  return { type: "text", text, citations: null } as unknown as BetaContentBlock;
}

export function toolUseBlock(name: string, input: unknown, id: string = nextId("toolu")): BetaContentBlock {
  return { type: "tool_use", id, name, input, caller: { type: "direct" } } as unknown as BetaContentBlock;
}

export function serverToolUseBlock(name: string, input: unknown, id: string = nextId("srvtoolu")): BetaContentBlock {
  return { type: "server_tool_use", id, name, input, caller: { type: "direct" } } as unknown as BetaContentBlock;
}

export function fakeMessage(opts: {
  content: BetaContentBlock[];
  stop_reason?: BetaMessage["stop_reason"];
  model?: string;
  usage?: FakeUsage;
  stop_details?: { type: "refusal"; category: string | null; explanation: string | null } | null;
}): BetaMessage {
  const u = opts.usage ?? {};
  const stop = opts.stop_reason ?? (opts.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
  return {
    id: nextId("msg"),
    type: "message",
    role: "assistant",
    model: opts.model ?? "claude-test",
    content: opts.content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: opts.stop_details ?? null,
    container: null,
    context_management: null,
    usage: {
      input_tokens: u.input_tokens ?? 100,
      output_tokens: u.output_tokens ?? 20,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cache_creation: null,
      server_tool_use: u.web_search_requests ? { web_search_requests: u.web_search_requests, web_fetch_requests: 0 } : null,
      service_tier: "standard",
      inference_geo: null,
      iterations: null,
    },
  } as unknown as BetaMessage;
}

/** Shorthand: a final text reply. */
export function textReply(text: string, usage?: FakeUsage): BetaMessage {
  return fakeMessage({ content: [textBlock(text)], ...(usage ? { usage } : {}) });
}

/** Shorthand: a structured-output reply (JSON text). */
export function jsonReply(value: unknown, usage?: FakeUsage): BetaMessage {
  return fakeMessage({ content: [textBlock(JSON.stringify(value))], ...(usage ? { usage } : {}) });
}

function chunk(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length ? out : [""];
}

function streamEvents(msg: BetaMessage, chunkSize: number): BetaStreamEvent[] {
  const ev: unknown[] = [];
  ev.push({ type: "message_start", message: { ...msg, content: [], stop_reason: null } });
  msg.content.forEach((b, index) => {
    if (b.type === "text") {
      ev.push({ type: "content_block_start", index, content_block: { ...b, text: "" } });
      for (const c of chunk(b.text, chunkSize)) ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: c } });
    } else if (b.type === "tool_use") {
      ev.push({ type: "content_block_start", index, content_block: { ...b, input: {} } });
      for (const c of chunk(JSON.stringify(b.input), chunkSize)) ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: c } });
    } else {
      ev.push({ type: "content_block_start", index, content_block: b });
    }
    ev.push({ type: "content_block_stop", index });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: msg.usage });
  ev.push({ type: "message_stop" });
  return ev as BetaStreamEvent[];
}

export interface FakeCall {
  kind: "create" | "stream";
  params: BetaStreamParams;
}

export class FakeAnthropic implements AnthropicLike {
  readonly calls: FakeCall[] = [];
  readonly batchRequests = new Map<string, BetaBatchCreateParams["requests"]>();
  private readonly queue: FakeResponse[];
  private readonly responder: FakeResponder | null;
  /** Number of `retrieve` polls before a batch reports `ended`. */
  pollsUntilEnded = 1;
  private polls = new Map<string, number>();
  chunkSize = 7;

  constructor(responses: FakeResponse[] | FakeResponder) {
    if (typeof responses === "function") {
      this.queue = [];
      this.responder = responses;
    } else {
      this.queue = [...responses];
      this.responder = null;
    }
  }

  private next(params: BetaStreamParams): BetaMessage {
    const idx = this.calls.length - 1;
    const r = this.responder ? this.responder(params, idx) : this.queue.shift();
    if (r === undefined) throw new Error(`FakeAnthropic: no scripted response for call #${idx}`);
    if (r instanceof Error) throw r;
    // Scripted messages without an explicit model report the requested model, like the API.
    return r.model === "claude-test" ? { ...r, model: params.model } : r;
  }

  readonly beta: AnthropicLike["beta"] = {
    messages: {
      create: async (params: BetaCreateParams) => {
        this.calls.push({ kind: "create", params });
        return this.next(params);
      },
      stream: (params: BetaStreamParams): MessageStreamLike => {
        this.calls.push({ kind: "stream", params });
        let msg: BetaMessage | null = null;
        let err: unknown = null;
        try {
          msg = this.next(params);
        } catch (e) {
          err = e;
        }
        const size = this.chunkSize;
        return {
          async *[Symbol.asyncIterator]() {
            if (err) throw err;
            for (const e of streamEvents(msg!, size)) yield e;
          },
          async finalMessage() {
            if (err) throw err;
            return msg!;
          },
        };
      },
      batches: {
        create: async (params: BetaBatchCreateParams) => {
          const id = nextId("msgbatch");
          this.batchRequests.set(id, params.requests);
          this.polls.set(id, 0);
          return this.batchObject(id, "in_progress");
        },
        retrieve: async (id: string) => {
          const n = (this.polls.get(id) ?? 0) + 1;
          this.polls.set(id, n);
          return this.batchObject(id, n >= this.pollsUntilEnded ? "ended" : "in_progress");
        },
        results: async (id: string) => {
          const reqs = this.batchRequests.get(id) ?? [];
          const out: BetaBatchResult[] = [];
          for (const r of reqs) {
            this.calls.push({ kind: "create", params: r.params as BetaStreamParams });
            let res: BetaBatchResult;
            try {
              const message = this.next(r.params as BetaStreamParams);
              res = { custom_id: r.custom_id, result: { type: "succeeded", message } } as unknown as BetaBatchResult;
            } catch (e) {
              res = { custom_id: r.custom_id, result: { type: "errored", error: { type: "error", error: { type: "api_error", message: String(e) } } } } as unknown as BetaBatchResult;
            }
            out.push(res);
          }
          out.reverse(); // results arrive in any order: callers must key by custom_id
          return (async function* () {
            for (const r of out) yield r;
          })();
        },
      },
    },
  };

  private batchObject(id: string, status: "in_progress" | "ended"): BetaMessageBatch {
    const n = this.batchRequests.get(id)?.length ?? 0;
    return {
      id,
      type: "message_batch",
      processing_status: status,
      request_counts: { processing: status === "ended" ? 0 : n, succeeded: status === "ended" ? n : 0, errored: 0, canceled: 0, expired: 0 },
      created_at: new Date(0).toISOString(),
      expires_at: new Date(0).toISOString(),
      ended_at: status === "ended" ? new Date(0).toISOString() : null,
      archived_at: null,
      cancel_initiated_at: null,
      results_url: null,
    } as unknown as BetaMessageBatch;
  }
}
