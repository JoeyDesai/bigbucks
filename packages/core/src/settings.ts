/**
 * Typed settings (spec §9.4 approval policy, §11.1 models, §11.7 AI cap, §11.6 notifications).
 * Stored as jsonb in `settings`; reads merge the stored value over the defaults and validate with Zod,
 * so a partially written or older value still parses.
 */
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { decryptSecret, encryptSecret, last4, settings } from "@homebase/db";
import { writeAudit } from "./audit";
import { withTx, type Ctx, type DbLike } from "./context";
import { ValidationError } from "./errors";

const conf = (d: number) => z.number().min(0).max(1).default(d);
const milliStr = (d: string) => z.string().regex(/^\d+$/, "milliunits as a decimal string").default(d);

export const SETTINGS_SCHEMAS = {
  /** §9.4 (keys match the demo seed). */
  approval_policy: z.object({
    auto_approve_rule_history_min_confidence: conf(0.95),
    auto_approve_ai_min_confidence: conf(0.95),
    /** AI auto-approve only when |amount| < this. */
    auto_approve_ai_max_abs_milli: milliStr("150000"),
    auto_categorize_min_confidence: conf(0.75),
    income_review_over_milli: milliStr("500000"),
    income_review_first_n: z.number().int().min(0).max(100).default(3),
  }),
  /** §11.1, all editable. */
  ai_models: z.object({
    chat: z.string().min(1).default("claude-sonnet-5-5"),
    deep: z.string().min(1).default("claude-opus-5-5"),
    categorize: z.string().min(1).default("claude-haiku-5-5"),
    merchant_lookup: z.string().min(1).default("claude-sonnet-5-5"),
    digest: z.string().min(1).default("claude-haiku-5-5"),
  }),
  /** §11.7 hard monthly cap (USD; AI cost is not household money, see ADR "DB: keys…"). */
  ai_budget: z.object({
    monthly_cap_usd: z.number().min(0).max(1000).default(8),
    warn_at_fraction: z.number().min(0).max(1).default(0.8),
    web_lookup_enabled: z.boolean().default(true),
  }),
  /** §11.6 alerts, each can be turned off. */
  notifications: z.object({
    connection_needs_attention: z.boolean().default(true),
    category_overspent: z.boolean().default(true),
    large_transaction: z.boolean().default(true),
    large_transaction_over_milli: milliStr("500000"),
    card_payment_due: z.boolean().default(true),
    card_payment_due_days: z.number().int().min(0).max(14).default(3),
    weekly_digest: z.boolean().default(true),
    ai_cap_warning: z.boolean().default(true),
    backup_stale: z.boolean().default(true),
  }),
  /** Accounts left off the Investments tab (empty or not worth showing). */
  investments_hidden: z.object({ account_ids: z.array(z.string().uuid()).max(500).default([]) }),
  timezone: z.literal("America/New_York").default("America/New_York"),
} as const;

export type SettingKey = keyof typeof SETTINGS_SCHEMAS;
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS_SCHEMAS)[K]>;
export type SettingPatch<K extends SettingKey> = SettingValue<K> extends object ? Partial<SettingValue<K>> : SettingValue<K>;

/** Only the admin may change these (§2). The web app enforces roles; this is the list it should use. */
export const ADMIN_ONLY_SETTINGS: readonly SettingKey[] = ["ai_models", "ai_budget"];

export const SETTING_KEYS = Object.keys(SETTINGS_SCHEMAS) as SettingKey[];

export function settingDefault<K extends SettingKey>(key: K): SettingValue<K> {
  return parseStored(key, undefined);
}

function isObjectSchema(key: SettingKey): boolean {
  return SETTINGS_SCHEMAS[key] instanceof z.ZodObject;
}

function parseStored<K extends SettingKey>(key: K, stored: unknown): SettingValue<K> {
  const schema = SETTINGS_SCHEMAS[key] as z.ZodType;
  if (isObjectSchema(key)) {
    const base = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
    const r = schema.safeParse(base);
    // a corrupt stored value falls back to defaults field by field
    if (r.success) return r.data as SettingValue<K>;
    const fallback: Record<string, unknown> = {};
    const shape = (schema as unknown as z.ZodObject<z.ZodRawShape>).shape;
    for (const [k, v] of Object.entries(base as Record<string, unknown>)) {
      const f = shape[k];
      if (f && (f as z.ZodType).safeParse(v).success) fallback[k] = v;
    }
    return schema.parse(fallback) as SettingValue<K>;
  }
  const r = schema.safeParse(stored ?? undefined);
  return (r.success ? r.data : schema.parse(undefined)) as SettingValue<K>;
}

export async function getSetting<K extends SettingKey>(db: DbLike, key: K): Promise<SettingValue<K>> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  return parseStored(key, row?.value);
}

export async function getAllSettings(db: DbLike): Promise<{ [K in SettingKey]: SettingValue<K> }> {
  const rows = await db.select({ key: settings.key, value: settings.value }).from(settings).where(inArray(settings.key, SETTING_KEYS));
  const by = new Map(rows.map((r) => [r.key, r.value]));
  const out = {} as Record<SettingKey, unknown>;
  for (const k of SETTING_KEYS) out[k] = parseStored(k, by.get(k));
  return out as { [K in SettingKey]: SettingValue<K> };
}

/** Merge `patch` into the current value, validate, store, audit. Returns the new value. */
export async function setSetting<K extends SettingKey>(ctx: Ctx, key: K, patch: SettingPatch<K>): Promise<SettingValue<K>> {
  if (!(key in SETTINGS_SCHEMAS)) throw new ValidationError(`unknown setting ${String(key)}`);
  return withTx(ctx, async (tx, c) => {
    const before = await getSetting(tx, key);
    const merged = isObjectSchema(key) ? { ...(before as object), ...(patch as object) } : patch;
    const r = (SETTINGS_SCHEMAS[key] as z.ZodType).safeParse(merged);
    if (!r.success) throw new ValidationError(`invalid ${key}: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    await tx
      .insert(settings)
      .values({ key, value: r.data as never, updatedBy: c.userId })
      .onConflictDoUpdate({ target: settings.key, set: { value: r.data as never, updatedBy: c.userId, updatedAt: new Date() } });
    await writeAudit(tx, c, { action: "settings.set", entity: "setting", entityId: key, before, after: r.data });
    return r.data as SettingValue<K>;
  });
}

// ── secret settings (VAPID private key, API keys): encrypted in settings.enc_value ──

export async function setSecretSetting(ctx: Ctx, key: string, plaintext: string): Promise<{ last4: string }> {
  if (!/^secret\./.test(key)) throw new ValidationError("secret setting keys start with 'secret.'");
  return withTx(ctx, async (tx, c) => {
    const enc = encryptSecret(plaintext);
    const l4 = last4(plaintext);
    await tx
      .insert(settings)
      .values({ key, value: { last4: l4 }, encValue: enc, updatedBy: c.userId })
      .onConflictDoUpdate({ target: settings.key, set: { value: { last4: l4 }, encValue: enc, updatedBy: c.userId, updatedAt: new Date() } });
    await writeAudit(tx, c, { action: "settings.set_secret", entity: "setting", entityId: key, after: { last4: l4 } });
    return { last4: l4 };
  });
}

export async function getSecretSetting(db: DbLike, key: string): Promise<string | null> {
  const [row] = await db.select({ enc: settings.encValue }).from(settings).where(eq(settings.key, key));
  return row?.enc ? decryptSecret(row.enc) : null;
}
