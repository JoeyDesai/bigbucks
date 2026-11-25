import "server-only";
/**
 * Web Push plumbing for the web app (§4.6, §11.6). Sending lives in the worker (apps/worker/src/push.ts);
 * this side stores subscriptions, exposes the VAPID public key and edits per-user alert preferences.
 * Settings keys and formats are the worker's:
 *   push_vapid        value {public_key, subject}, enc_value = private key (base64url, encrypted)
 *   push_preferences  { [userId]: { [alertType]: boolean } } — missing = enabled
 */
import { createECDH } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withTx, writeAudit, type Ctx } from "@homebase/core";
import { encryptSecret, pushSubscriptions, settings, type Db } from "@homebase/db";

export const PUSH_VAPID_KEY = "push_vapid";
export const PUSH_PREFERENCES_KEY = "push_preferences";
/** Placeholder until VAPID_SUBJECT (or Settings → Notifications → Push sender) gives a real contact address. */
export const DEFAULT_VAPID_SUBJECT = "mailto:homebase@homebase.invalid";
const vapidSubjectDefault = () => process.env.VAPID_SUBJECT?.trim() || DEFAULT_VAPID_SUBJECT;

/** Mirrors ALERT_TYPES in apps/worker/src/push.ts. */
export const ALERT_TYPES = [
  { type: "overspent", label: "A category goes overspent", admin: false },
  { type: "large_transaction", label: "A large transaction (over $500)", admin: false },
  { type: "card_due", label: "Card payment due in 3 days", admin: false },
  { type: "digest", label: "Weekly digest (Sunday evening)", admin: false },
  { type: "connection", label: "A connection needs reconnecting", admin: true },
  { type: "backup", label: "Backups are stale or failing", admin: true },
  { type: "ai_cost", label: "AI spend reaches 80% of the monthly cap", admin: true },
] as const;
export type AlertType = (typeof ALERT_TYPES)[number]["type"];

const b64url = (b: Buffer) => b.toString("base64url");

/** A P-256 VAPID key pair in web-push's format (uncompressed public point, 32-byte private scalar). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const priv = ecdh.getPrivateKey();
  const padded = priv.length === 32 ? priv : Buffer.concat([Buffer.alloc(32 - priv.length), priv]);
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(padded) };
}

export interface VapidPublic {
  publicKey: string;
  subject: string;
}

/** Read the VAPID public key; generate and store a pair (worker format) if none exists yet. */
export async function getOrCreateVapidPublic(db: Db): Promise<VapidPublic> {
  const [row] = await db.select({ value: settings.value, enc: settings.encValue }).from(settings).where(eq(settings.key, PUSH_VAPID_KEY));
  const v = row?.value as { public_key?: string; subject?: string } | null | undefined;
  if (row?.enc && v?.public_key) return { publicKey: v.public_key, subject: v.subject ?? vapidSubjectDefault() };
  const k = generateVapidKeys();
  const subject = vapidSubjectDefault();
  const encValue = encryptSecret(k.privateKey);
  // ON CONFLICT DO NOTHING: if the worker created keys concurrently, its pair wins.
  await db.insert(settings).values({ key: PUSH_VAPID_KEY, value: { public_key: k.publicKey, subject }, encValue }).onConflictDoNothing({ target: settings.key });
  const [after] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, PUSH_VAPID_KEY));
  const a = after?.value as { public_key?: string; subject?: string } | undefined;
  return { publicKey: a?.public_key ?? k.publicKey, subject: a?.subject ?? subject };
}

export async function setVapidSubject(ctx: Ctx, subject: string): Promise<void> {
  if (!/^(mailto:[^@\s]+@[^@\s]+\.[^@\s]+|https:\/\/\S+)$/.test(subject)) throw new Error("The subject must be a mailto: address or an https:// URL.");
  await withTx(ctx, async (tx, c) => {
    const [row] = await tx.select({ value: settings.value }).from(settings).where(eq(settings.key, PUSH_VAPID_KEY));
    const v = (row?.value ?? {}) as { public_key?: string; subject?: string };
    if (!v.public_key) throw new Error("Push keys don't exist yet. Open Notifications once to create them.");
    await tx.update(settings).set({ value: { ...v, subject }, updatedBy: c.userId, updatedAt: new Date() }).where(eq(settings.key, PUSH_VAPID_KEY));
    await writeAudit(tx, c, { action: "settings.set", entity: "setting", entityId: PUSH_VAPID_KEY, before: { subject: v.subject ?? null }, after: { subject } });
  });
}

type Prefs = Record<string, Partial<Record<AlertType, boolean>>>;

export async function getPushPreferences(db: Db, userId: string): Promise<Record<AlertType, boolean>> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, PUSH_PREFERENCES_KEY));
  const mine = ((row?.value ?? {}) as Prefs)[userId] ?? {};
  return Object.fromEntries(ALERT_TYPES.map((a) => [a.type, mine[a.type] !== false])) as Record<AlertType, boolean>;
}

export async function setPushPreference(ctx: Ctx, userId: string, type: AlertType, enabled: boolean): Promise<void> {
  await withTx(ctx, async (tx, c) => {
    const [row] = await tx.select({ value: settings.value }).from(settings).where(eq(settings.key, PUSH_PREFERENCES_KEY)).for("update");
    const prefs = { ...((row?.value ?? {}) as Prefs) };
    const before = prefs[userId]?.[type] !== false;
    prefs[userId] = { ...(prefs[userId] ?? {}), [type]: enabled };
    await tx
      .insert(settings)
      .values({ key: PUSH_PREFERENCES_KEY, value: prefs, updatedBy: c.userId })
      .onConflictDoUpdate({ target: settings.key, set: { value: prefs, updatedBy: c.userId, updatedAt: new Date() } });
    await writeAudit(tx, c, { action: "settings.push_preference", entity: "setting", entityId: `${PUSH_PREFERENCES_KEY}.${type}`, before: { userId, enabled: before }, after: { userId, enabled } });
  });
}

export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export async function saveSubscription(db: Db, userId: string, sub: SubscriptionInput, userAgent: string | null): Promise<void> {
  await db
    .insert(pushSubscriptions)
    .values({ userId, endpoint: sub.endpoint, keys: sub.keys, userAgent: userAgent?.slice(0, 300) ?? null })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId, keys: sub.keys, userAgent: userAgent?.slice(0, 300) ?? null, updatedAt: new Date() } });
}

export async function deleteSubscription(db: Db, userId: string, endpoint: string): Promise<boolean> {
  const rows = await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint))).returning({ id: pushSubscriptions.id });
  return rows.length > 0;
}

export async function listSubscriptions(db: Db, userId: string) {
  return db.select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint, userAgent: pushSubscriptions.userAgent, createdAt: pushSubscriptions.createdAt }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
}
