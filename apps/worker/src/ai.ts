/**
 * AI client for worker jobs (categorization, digest). The key comes from Settings → AI (encrypted
 * `secret.anthropic_api_key`) or ANTHROPIC_API_KEY; without one this returns null → categorization
 * uses rules + history only and the digest is deterministic. Usage is recorded in `ai_usage`
 * (DbUsageSink) against the same `ai_budget` cap the web app enforces (§11.7).
 */
import { AiClient, type ModelConfig } from "@homebase/ai";
import { DbUsageSink } from "@homebase/ai/db";
import { getSecretSetting, getSetting as getCoreSetting } from "@homebase/core";
import type { Db } from "@homebase/db";

export const ANTHROPIC_KEY_SETTING = "secret.anthropic_api_key";

/** settings.ai_models uses snake_case keys; map them onto ModelConfig. */
export async function modelOverrides(db: Db): Promise<Partial<ModelConfig>> {
  const s = await getCoreSetting(db, "ai_models");
  return { chat: s.chat, deep: s.deep, categorize: s.categorize, digest: s.digest, merchantLookup: s.merchant_lookup };
}

async function resolveKey(db: Db, envKey: string | undefined): Promise<string | null> {
  try {
    const stored = await getSecretSetting(db, ANTHROPIC_KEY_SETTING);
    if (stored) return stored;
  } catch {
    // Undecryptable (e.g. master key rotated away) — fall back to env.
  }
  return envKey ?? null;
}

export async function createWorkerAiClient(db: Db, envKey: string | undefined): Promise<AiClient | null> {
  const apiKey = await resolveKey(db, envKey);
  if (!apiKey) return null;
  const budget = await getCoreSetting(db, "ai_budget");
  return new AiClient({
    apiKey,
    usage: new DbUsageSink(db),
    models: await modelOverrides(db),
    capMicroUsd: BigInt(Math.round(budget.monthly_cap_usd * 100)) * 10_000n,
  });
}
