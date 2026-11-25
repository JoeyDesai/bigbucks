import "server-only";
import { AiClient, capStateFor, monthForInstant, type AnthropicLike, type CapState, type ModelConfig } from "@homebase/ai";
import { DbUsageSink } from "@homebase/ai/db";
import { getSecretSetting, getSetting } from "@homebase/core";
import type { Db } from "@homebase/db";
import { log } from "@/server/log";

/** settings row holding the encrypted Anthropic key (core secret-setting format: value {last4}, enc_value). */
export const ANTHROPIC_KEY_SETTING = "secret.anthropic_api_key";

export type KeySource = "settings" | "env" | null;

/** Dollars (number, from settings) → micro-USD, exactly at cent precision. */
export function usdToMicroUsd(usd: number): bigint {
  return BigInt(Math.round(usd * 100)) * 10_000n;
}

/** ai_models (snake_case in settings) → ModelConfig overrides. */
export function modelOverrides(s: { chat: string; deep: string; categorize: string; digest: string; merchant_lookup: string }): Partial<ModelConfig> {
  return { chat: s.chat, deep: s.deep, categorize: s.categorize, digest: s.digest, merchantLookup: s.merchant_lookup };
}

export async function resolveAnthropicKey(db: Db): Promise<{ key: string | null; source: KeySource; error?: string }> {
  try {
    const stored = await getSecretSetting(db, ANTHROPIC_KEY_SETTING);
    if (stored) return { key: stored, source: "settings" };
  } catch (e) {
    // e.g. HOMEBASE_MASTER_KEY missing or rotated away; fall through to env.
    log.warn({ err: (e as Error).message }, "stored Anthropic key could not be decrypted");
    const env = process.env.ANTHROPIC_API_KEY;
    if (env) return { key: env, source: "env" };
    return { key: null, source: null, error: "The stored Anthropic key can't be decrypted (check HOMEBASE_MASTER_KEY)." };
  }
  const env = process.env.ANTHROPIC_API_KEY;
  return env ? { key: env, source: "env" } : { key: null, source: null };
}

export interface AiStatus {
  configured: boolean;
  keySource: KeySource;
  keyError?: string;
  month: string;
  spentMicroUsd: bigint;
  capMicroUsd: bigint;
  state: CapState;
  webLookupEnabled: boolean;
  models: ModelConfig;
}

/** Test hook: inject a fake Anthropic client for every AiClient built in this process. */
const G = globalThis as unknown as { __homebaseFakeAnthropic?: AnthropicLike | null };
export function setAnthropicOverride(a: AnthropicLike | null): void {
  G.__homebaseFakeAnthropic = a;
}

/**
 * Build the AiClient used by Ask: key from Settings (encrypted) or ANTHROPIC_API_KEY, usage in
 * ai_usage, cap and model ids from settings. Returns null when no key is configured.
 */
export async function buildAiClient(db: Db, o: { anthropic?: AnthropicLike; now?: () => Date } = {}): Promise<AiClient | null> {
  const [budget, models] = [await getSetting(db, "ai_budget"), await getSetting(db, "ai_models")];
  const anthropic = o.anthropic ?? G.__homebaseFakeAnthropic ?? undefined;
  let apiKey: string | null = null;
  if (!anthropic) {
    apiKey = (await resolveAnthropicKey(db)).key;
    if (!apiKey) return null;
  }
  return new AiClient({
    ...(anthropic ? { anthropic } : { apiKey: apiKey! }),
    usage: new DbUsageSink(db),
    models: modelOverrides(models),
    capMicroUsd: usdToMicroUsd(budget.monthly_cap_usd),
    ...(o.now ? { now: o.now } : {}),
  });
}

export async function getAiStatus(db: Db, now: Date = new Date()): Promise<AiStatus> {
  const [budget, models, key] = [await getSetting(db, "ai_budget"), await getSetting(db, "ai_models"), await resolveAnthropicKey(db)];
  const month = monthForInstant(now);
  const spent = await new DbUsageSink(db).monthToDateMicroUsd(month);
  const cap = usdToMicroUsd(budget.monthly_cap_usd);
  const hasFake = !!G.__homebaseFakeAnthropic;
  return {
    configured: !!key.key || hasFake,
    keySource: hasFake ? "env" : key.source,
    ...(key.error ? { keyError: key.error } : {}),
    month,
    spentMicroUsd: spent,
    capMicroUsd: cap,
    state: capStateFor(spent, cap),
    webLookupEnabled: budget.web_lookup_enabled,
    models: { chat: models.chat, deep: models.deep, categorize: models.categorize, digest: models.digest, merchantLookup: models.merchant_lookup },
  };
}
