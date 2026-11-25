/**
 * Usage accounting and the monthly hard cap (spec §11.7, §5.4 ai_usage).
 *
 * Cost math is exact: token counts × micro-USD-per-MTok gives pico-USD as a bigint, which is
 * rounded once to micro-USD per call. The cap is compared in micro-USD.
 */
import { monthOf, toLocalDate, type Month } from "@homebase/shared";
import { priceFor, WEB_SEARCH_MICRO_USD, type PriceTable, DEFAULT_PRICES } from "./models";

export const AI_PURPOSES = ["chat", "categorize", "batch_categorize", "merchant_lookup", "digest", "report"] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number];

/** Token usage in the shape the API returns (beta and non-beta `usage` both satisfy this). */
export interface TokenUsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
  iterations?: ReadonlyArray<{
    type: string;
    model?: string | null;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  }> | null;
}

export interface UsageRecord {
  /** ISO timestamp. */
  at: string;
  /** Calendar month (America/New_York) the cost counts against. */
  month: Month;
  purpose: AiPurpose;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  batch: boolean;
  costMicroUsd: bigint;
  /** True when the model was missing from the price table (cost uses the most expensive known price). */
  estimated: boolean;
  conversationId?: string;
  transactionId?: string;
  userId?: string;
}

/** Persistence for ai_usage rows. The db layer implements this. */
export interface UsageSink {
  record(rec: UsageRecord): Promise<void>;
  /** Sum of costMicroUsd for the given month. */
  monthToDateMicroUsd(month: Month): Promise<bigint>;
}

export type AiEvent =
  | { type: "cap_warning"; month: Month; spentMicroUsd: bigint; capMicroUsd: bigint }
  | { type: "cap_reached"; month: Month; spentMicroUsd: bigint; capMicroUsd: bigint }
  | { type: "web_query_rejected"; query: string; reason: string }
  | { type: "refusal"; purpose: AiPurpose; model: string; category: string | null };

/** Where notable AI events go (push notification for cap warnings, logs for the rest). */
export interface AiEventSink {
  emit(e: AiEvent): void | Promise<void>;
}

export interface CostBreakdown {
  costMicroUsd: bigint;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  estimated: boolean;
}

function roundPicoToMicro(pico: bigint): bigint {
  return (pico + 500_000n) / 1_000_000n;
}

interface Segment {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
}

function segmentPico(seg: Segment, table: PriceTable, batch: boolean): { pico: bigint; known: boolean } {
  const { price, known } = priceFor(seg.model, table);
  const promptTokens = seg.input + seg.cacheRead + seg.write5m + seg.write1h;
  const p = price.longContext && promptTokens > price.longContext.thresholdTokens ? price.longContext : price;
  let pico =
    BigInt(seg.input) * p.input +
    BigInt(seg.output) * p.output +
    BigInt(seg.cacheRead) * p.cacheRead +
    BigInt(seg.write5m) * p.cacheWrite5m +
    BigInt(seg.write1h) * p.cacheWrite1h;
  if (batch) pico = pico / 2n; // Message Batches: 50% off all token usage
  return { pico, known };
}

function splitWrites(total: number, cc: TokenUsageLike["cache_creation"]): { w5: number; w1: number } {
  const w1 = cc?.ephemeral_1h_input_tokens ?? 0;
  const w5 = cc?.ephemeral_5m_input_tokens ?? Math.max(0, total - w1);
  return { w5, w1 };
}

/**
 * Compute the cost of one API response. When the response was served partly by a fallback
 * model (`usage.iterations` contains `fallback_message` entries), each iteration is priced at
 * its own model's rates.
 */
export function computeCost(
  model: string,
  usage: TokenUsageLike,
  opts: { batch?: boolean; prices?: PriceTable } = {},
): CostBreakdown {
  const table = opts.prices ?? DEFAULT_PRICES;
  const batch = opts.batch ?? false;
  const webSearches = usage.server_tool_use?.web_search_requests ?? 0;
  const segments: Segment[] = [];
  const its = usage.iterations ?? [];
  if (its.some((i) => i.type === "fallback_message")) {
    for (const it of its) {
      const writes = splitWrites(it.cache_creation_input_tokens ?? 0, it.cache_creation);
      segments.push({
        model: it.model ?? model,
        input: it.input_tokens ?? 0,
        output: it.output_tokens ?? 0,
        cacheRead: it.cache_read_input_tokens ?? 0,
        write5m: writes.w5,
        write1h: writes.w1,
      });
    }
  } else {
    const writes = splitWrites(usage.cache_creation_input_tokens ?? 0, usage.cache_creation);
    segments.push({
      model,
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      write5m: writes.w5,
      write1h: writes.w1,
    });
  }
  let pico = 0n;
  let known = true;
  for (const s of segments) {
    const r = segmentPico(s, table, batch);
    pico += r.pico;
    known &&= r.known;
  }
  pico += BigInt(webSearches) * WEB_SEARCH_MICRO_USD * 1_000_000n;
  return {
    costMicroUsd: roundPicoToMicro(pico),
    inputTokens: segments.reduce((a, s) => a + s.input, 0),
    outputTokens: segments.reduce((a, s) => a + s.output, 0),
    cacheReadTokens: segments.reduce((a, s) => a + s.cacheRead, 0),
    cacheWriteTokens: segments.reduce((a, s) => a + s.write5m + s.write1h, 0),
    webSearches,
    estimated: !known,
  };
}

export function microUsdToUsdString(micro: bigint): string {
  const neg = micro < 0n;
  const a = neg ? -micro : micro;
  const s = `${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, "0")}`;
  return neg ? `-${s}` : s;
}

export function usdToMicro(usd: string | number): bigint {
  const s = String(usd).trim();
  const m = /^(\d*)(?:\.(\d{0,6})\d*)?$/.exec(s);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) throw new Error(`Invalid USD amount: ${usd}`);
  return BigInt(m[1] || "0") * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

export const DEFAULT_MONTHLY_CAP_MICRO_USD = 8_000_000n; // $8
export const CAP_WARNING_RATIO_PCT = 80n;

export type CapState = "ok" | "warning" | "exceeded";

export interface CapStatus {
  month: Month;
  spentMicroUsd: bigint;
  capMicroUsd: bigint;
  state: CapState;
}

export function capStateFor(spent: bigint, cap: bigint): CapState {
  if (cap <= 0n) return "exceeded";
  if (spent >= cap) return "exceeded";
  if (spent * 100n >= cap * CAP_WARNING_RATIO_PCT) return "warning";
  return "ok";
}

export function monthForInstant(d: Date): Month {
  return monthOf(toLocalDate(d));
}

/** In-memory UsageSink for tests and the evaluation harness. */
export class InMemoryUsageSink implements UsageSink {
  readonly records: UsageRecord[] = [];
  constructor(private readonly seedByMonth: Record<string, bigint> = {}) {}
  async record(rec: UsageRecord): Promise<void> {
    this.records.push(rec);
  }
  async monthToDateMicroUsd(month: Month): Promise<bigint> {
    let t = this.seedByMonth[month] ?? 0n;
    for (const r of this.records) if (r.month === month) t += r.costMicroUsd;
    return t;
  }
  totalMicroUsd(): bigint {
    return this.records.reduce((a, r) => a + r.costMicroUsd, 0n);
  }
}
