/**
 * Anthropic client factory (server-only), model config, retries, usage accounting and the
 * monthly hard cap (spec §4.6, §11.1, §11.7).
 *
 * All calls go through the SDK's `beta.messages` surface so Sonnet/Opus requests can carry the
 * server-side refusal fallback (`fallbacks: "default"`) — see docs/decisions.md.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { resolveModels, type ModelConfig, type PriceTable, DEFAULT_PRICES, FALLBACK_CAPABLE_MODELS, REFUSAL_FALLBACK_BETA } from "./models";
import {
  computeCost,
  capStateFor,
  monthForInstant,
  DEFAULT_MONTHLY_CAP_MICRO_USD,
  type AiEventSink,
  type AiPurpose,
  type CapStatus,
  type TokenUsageLike,
  type UsageRecord,
  type UsageSink,
} from "./usage";

export type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
export type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
export type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
export type BetaToolUseBlock = Anthropic.Beta.Messages.BetaToolUseBlock;
export type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;
export type BetaTool = Anthropic.Beta.Messages.BetaTool;
export type BetaToolUnion = Anthropic.Beta.Messages.BetaToolUnion;
export type BetaTextBlockParam = Anthropic.Beta.Messages.BetaTextBlockParam;
export type BetaCreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
export type BetaStreamParams = BetaMessageStreamParams;
export type BetaStreamEvent = Anthropic.Beta.Messages.BetaRawMessageStreamEvent;
export type BetaMessageBatch = Anthropic.Beta.Messages.Batches.BetaMessageBatch;
export type BetaBatchCreateParams = Anthropic.Beta.Messages.Batches.BatchCreateParams;
export type BetaBatchRequest = Anthropic.Beta.Messages.Batches.BatchCreateParams.Request;
export type BetaBatchResult = Anthropic.Beta.Messages.Batches.BetaMessageBatchIndividualResponse;

export interface MessageStreamLike extends AsyncIterable<BetaStreamEvent> {
  finalMessage(): Promise<BetaMessage>;
}

export interface CallOptions {
  signal?: AbortSignal;
}

/**
 * The subset of the Anthropic SDK this package uses. The real `Anthropic` client satisfies it;
 * tests inject a fake (see `@homebase/ai/testing`).
 */
export interface AnthropicLike {
  beta: {
    messages: {
      create(params: BetaCreateParams, options?: CallOptions): PromiseLike<BetaMessage>;
      stream(params: BetaStreamParams, options?: CallOptions): MessageStreamLike;
      batches: {
        create(params: BetaBatchCreateParams, options?: CallOptions): PromiseLike<BetaMessageBatch>;
        retrieve(id: string, params?: undefined, options?: CallOptions): PromiseLike<BetaMessageBatch>;
        results(id: string, params?: undefined, options?: CallOptions): Promise<AsyncIterable<BetaBatchResult>>;
      };
    };
  };
}

export class AiCapExceededError extends Error {
  constructor(readonly status: CapStatus) {
    super(`AI monthly cap reached (${status.spentMicroUsd} of ${status.capMicroUsd} micro-USD)`);
    this.name = "AiCapExceededError";
  }
}

export class AiDisabledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AiDisabledError";
  }
}

export interface AnthropicFactoryOptions {
  apiKey?: string;
  /** SDK-level retries for 408/409/429/5xx and connection errors (exponential backoff). */
  maxRetries?: number;
  timeoutMs?: number;
}

/** Create the real SDK client. Throws if called in a browser: the API key is server-only (§4.6). */
export function createAnthropicClient(opts: AnthropicFactoryOptions = {}): Anthropic {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
    throw new Error("@homebase/ai client is server-only; the Anthropic key must never reach the browser");
  }
  return new Anthropic({
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    maxRetries: opts.maxRetries ?? 3,
    timeout: opts.timeoutMs ?? 120_000,
  });
}

export interface AiClientOptions {
  /** Inject a client (tests, or a pre-built SDK client). Otherwise one is created from apiKey/env. */
  anthropic?: AnthropicLike;
  apiKey?: string;
  models?: Partial<ModelConfig> | null;
  usage: UsageSink;
  events?: AiEventSink;
  /** Monthly hard cap in micro-USD (default $8). */
  capMicroUsd?: bigint;
  prices?: PriceTable;
  now?: () => Date;
  maxRetries?: number;
  timeoutMs?: number;
  /** Master switch from Settings (e.g. no key configured). */
  enabled?: boolean;
  /** Add `fallbacks: "default"` on fallback-capable models (default true). */
  refusalFallback?: boolean;
}

export interface UsageMeta {
  batch?: boolean;
  conversationId?: string;
  transactionId?: string;
  userId?: string;
}

export class AiClient {
  readonly anthropic: AnthropicLike;
  readonly models: ModelConfig;
  readonly prices: PriceTable;
  readonly capMicroUsd: bigint;
  readonly refusalFallback: boolean;
  readonly enabled: boolean;
  private readonly usage: UsageSink;
  private readonly events: AiEventSink | undefined;
  readonly now: () => Date;

  constructor(opts: AiClientOptions) {
    this.anthropic =
      opts.anthropic ??
      (createAnthropicClient({
        ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
        ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      }) as unknown as AnthropicLike);
    this.models = resolveModels(opts.models);
    this.prices = opts.prices ?? DEFAULT_PRICES;
    this.capMicroUsd = opts.capMicroUsd ?? DEFAULT_MONTHLY_CAP_MICRO_USD;
    this.refusalFallback = opts.refusalFallback ?? true;
    this.enabled = opts.enabled ?? true;
    this.usage = opts.usage;
    this.events = opts.events;
    this.now = opts.now ?? (() => new Date());
  }

  async capStatus(): Promise<CapStatus> {
    const month = monthForInstant(this.now());
    const spent = await this.usage.monthToDateMicroUsd(month);
    return { month, spentMicroUsd: spent, capMicroUsd: this.capMicroUsd, state: capStateFor(spent, this.capMicroUsd) };
  }

  /**
   * At 100% of the cap every AI purpose is off: chat is disabled and categorization falls back to
   * rules and history (§11.7). Digests fall back to deterministic text.
   */
  async isAvailable(_purpose: AiPurpose): Promise<boolean> {
    if (!this.enabled) return false;
    const s = await this.capStatus();
    return s.state !== "exceeded";
  }

  async assertAvailable(purpose: AiPurpose): Promise<void> {
    if (!this.enabled) throw new AiDisabledError("AI is disabled in Settings");
    const s = await this.capStatus();
    if (s.state === "exceeded") {
      await this.events?.emit({ type: "cap_reached", month: s.month, spentMicroUsd: s.spentMicroUsd, capMicroUsd: s.capMicroUsd });
      throw new AiCapExceededError(s);
    }
    void purpose;
  }

  /** Records one response's usage and fires the 80% / 100% events when this call crosses them. */
  async recordUsage(purpose: AiPurpose, model: string, usage: TokenUsageLike, meta: UsageMeta = {}): Promise<UsageRecord> {
    const at = this.now();
    const month = monthForInstant(at);
    const before = await this.usage.monthToDateMicroUsd(month);
    const cost = computeCost(model, usage, { batch: meta.batch ?? false, prices: this.prices });
    const rec: UsageRecord = {
      at: at.toISOString(),
      month,
      purpose,
      model,
      inputTokens: cost.inputTokens,
      outputTokens: cost.outputTokens,
      cacheReadTokens: cost.cacheReadTokens,
      cacheWriteTokens: cost.cacheWriteTokens,
      webSearches: cost.webSearches,
      batch: meta.batch ?? false,
      costMicroUsd: cost.costMicroUsd,
      estimated: cost.estimated,
      ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
      ...(meta.transactionId ? { transactionId: meta.transactionId } : {}),
      ...(meta.userId ? { userId: meta.userId } : {}),
    };
    await this.usage.record(rec);
    const after = before + cost.costMicroUsd;
    const sBefore = capStateFor(before, this.capMicroUsd);
    const sAfter = capStateFor(after, this.capMicroUsd);
    if (sBefore === "ok" && sAfter !== "ok") {
      await this.events?.emit({ type: "cap_warning", month, spentMicroUsd: after, capMicroUsd: this.capMicroUsd });
    }
    if (sBefore !== "exceeded" && sAfter === "exceeded") {
      await this.events?.emit({ type: "cap_reached", month, spentMicroUsd: after, capMicroUsd: this.capMicroUsd });
    }
    return rec;
  }

  /** Adds the server-side refusal fallback for models that support it (never for Batches). */
  withRefusalFallback<T extends BetaStreamParams>(params: T): T & Pick<BetaStreamParams, "betas" | "fallbacks"> {
    if (!this.refusalFallback || !FALLBACK_CAPABLE_MODELS.has(params.model)) return params;
    const betas = [...(params.betas ?? [])];
    if (!betas.includes(REFUSAL_FALLBACK_BETA)) betas.push(REFUSAL_FALLBACK_BETA);
    return { ...params, betas, fallbacks: "default" };
  }

  /** Gated, recorded, non-streaming call. Emits a `refusal` event when the model declines. */
  async create(purpose: AiPurpose, params: BetaCreateParams, meta: UsageMeta & CallOptions = {}): Promise<BetaMessage> {
    await this.assertAvailable(purpose);
    const msg = await this.anthropic.beta.messages.create(
      this.withRefusalFallback(params),
      meta.signal ? { signal: meta.signal } : undefined,
    );
    await this.recordUsage(purpose, msg.model || params.model, msg.usage, meta);
    if (msg.stop_reason === "refusal") {
      await this.events?.emit({ type: "refusal", purpose, model: msg.model, category: msg.stop_details?.category ?? null });
    }
    return msg;
  }

  async emit(e: Parameters<AiEventSink["emit"]>[0]): Promise<void> {
    await this.events?.emit(e);
  }
}

export function textOf(msg: { content: ReadonlyArray<{ type: string }> }): string {
  let out = "";
  for (const b of msg.content) if (b.type === "text") out += (b as unknown as { text: string }).text;
  return out;
}
