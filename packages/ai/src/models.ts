/**
 * Model configuration and the price table used for usage accounting (spec §11.1, §11.7).
 *
 * Prices are integer micro-USD per million tokens so cost math stays exact (bigint).
 * Every model ID is editable in Settings; unknown models fall back to the most expensive
 * known price so the monthly cap errs on the safe side.
 */

export interface ModelConfig {
  /** Ask chat agent (§11.2). */
  chat: string;
  /** "Deep analysis" toggle in Ask. */
  deep: string;
  /** Real-time + batch categorization (§9.3). */
  categorize: string;
  /** Weekly digest (§11.6). */
  digest: string;
  /** Unknown-merchant identification with web_search (§9.1 step 5). */
  merchantLookup: string;
}

export const DEFAULT_MODELS: ModelConfig = {
  chat: "claude-sonnet-5-5",
  deep: "claude-opus-5-5",
  categorize: "claude-haiku-5-5",
  digest: "claude-haiku-5-5",
  merchantLookup: "claude-sonnet-5-5",
};

export function resolveModels(overrides?: Partial<ModelConfig> | null): ModelConfig {
  const out: ModelConfig = { ...DEFAULT_MODELS };
  for (const k of Object.keys(DEFAULT_MODELS) as (keyof ModelConfig)[]) {
    const v = overrides?.[k];
    if (typeof v === "string" && v.trim() !== "") out[k] = v.trim();
  }
  return out;
}

/** Micro-USD per million tokens. */
export interface ModelPrice {
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite5m: bigint;
  cacheWrite1h: bigint;
  /** Optional long-context tier (e.g. Haiku 5.5 above 100K prompt tokens). */
  longContext?: { thresholdTokens: number; input: bigint; output: bigint; cacheRead: bigint; cacheWrite5m: bigint; cacheWrite1h: bigint };
}

const M = (usd: number): bigint => BigInt(Math.round(usd * 1_000_000));

function price(inputUsd: number, outputUsd: number, cacheReadUsd: number): Omit<ModelPrice, "longContext"> {
  return {
    input: M(inputUsd),
    output: M(outputUsd),
    cacheRead: M(cacheReadUsd),
    cacheWrite5m: (M(inputUsd) * 125n) / 100n, // 1.25x base input
    cacheWrite1h: M(inputUsd) * 2n, // 2x base input
  };
}

export type PriceTable = Record<string, ModelPrice>;

/** Anthropic first-party prices as of Oct 2026 (cached from the claude-api reference). */
export const DEFAULT_PRICES: PriceTable = {
  "claude-sonnet-5-5": price(2, 10, 0.2),
  "claude-opus-5-5": price(4, 20, 0.2),
  "claude-haiku-5-5": {
    ...price(0.1, 0.5, 0.01),
    longContext: { thresholdTokens: 100_000, ...price(0.5, 2.5, 0.05) },
  },
  "claude-sonnet-5": price(2, 10, 0.2),
  "claude-opus-5": price(5, 25, 0.5),
  "claude-haiku-4-5": price(1, 5, 0.1),
  "claude-fable-5-1": price(10, 50, 0.25),
};

/** $10 per 1,000 web searches = 10,000 micro-USD per search. */
export const WEB_SEARCH_MICRO_USD = 10_000n;

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`) on the Claude API. */
export const FALLBACK_CAPABLE_MODELS: ReadonlySet<string> = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
export const REFUSAL_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export function priceFor(model: string, table: PriceTable = DEFAULT_PRICES): { price: ModelPrice; known: boolean } {
  const exact = table[model];
  if (exact) return { price: exact, known: true };
  // Allow provider-prefixed IDs like "anthropic.claude-haiku-5-5".
  const stripped = model.replace(/^[a-z]+\./, "");
  const p = table[stripped];
  if (p) return { price: p, known: true };
  let worst: ModelPrice | undefined;
  for (const v of Object.values(table)) if (!worst || v.output > worst.output) worst = v;
  return { price: worst ?? price(10, 50, 1), known: false };
}
