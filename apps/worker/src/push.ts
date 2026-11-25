/**
 * Web Push (§4.6, §11.6) via web-push 3.6.7.
 *
 *  - VAPID keys are generated on first use and stored in `settings.push_vapid`: the public key and
 *    subject in `value` (the web app reads the public key to subscribe), the private key encrypted in
 *    `enc_value`.
 *  - Messages go to every `push_subscriptions` row of the user. 404/410 responses prune the row.
 *  - Per-alert-type preferences: `settings.push_preferences` = { [userId]: { [type]: boolean } };
 *    a missing entry means enabled.
 */
import { eq } from "drizzle-orm";
import webpush, { type RequestOptions } from "web-push";
import { pushSubscriptions, users, type Db, type Keyring } from "@homebase/db";
import type { Logger } from "./log";
import { errInfo } from "./log";
import { SETTING_KEYS, getSecretSetting, getSetting, setSecretSetting } from "./settings";

export const ALERT_TYPES = ["connection", "backup", "digest", "overspent", "large_transaction", "card_due", "ai_cost"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export interface PushMessage {
  title: string;
  body: string;
  /** In-app path to open when tapped. */
  url?: string;
  /** Collapses repeats of the same alert on the device. */
  tag?: string;
}

export interface PushOutcome {
  sent: number;
  pruned: number;
  failed: number;
  skipped: boolean;
}

export interface Pusher {
  sendToUser(userId: string, type: AlertType, msg: PushMessage): Promise<PushOutcome>;
  /** Admins only: connection, backup and cost alerts (§2). */
  sendToAdmins(type: AlertType, msg: PushMessage): Promise<PushOutcome>;
  sendToAll(type: AlertType, msg: PushMessage): Promise<PushOutcome>;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export type SendFn = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, opts: RequestOptions) => Promise<{ statusCode: number }>;

export async function getOrCreateVapidKeys(db: Db, subject: string, keyring?: Keyring): Promise<VapidKeys> {
  const stored = await getSecretSetting(db, SETTING_KEYS.pushVapid, keyring);
  const v = stored?.value as { public_key?: string; subject?: string } | undefined;
  if (stored?.secret && v?.public_key) return { publicKey: v.public_key, privateKey: stored.secret, subject: v.subject ?? subject };
  const k = webpush.generateVAPIDKeys();
  await setSecretSetting(db, SETTING_KEYS.pushVapid, { public_key: k.publicKey, subject }, k.privateKey, keyring);
  return { publicKey: k.publicKey, privateKey: k.privateKey, subject };
}

export async function alertEnabled(db: Db, userId: string, type: AlertType): Promise<boolean> {
  const prefs = await getSetting<Record<string, Partial<Record<AlertType, boolean>>>>(db, SETTING_KEYS.pushPreferences);
  return prefs?.[userId]?.[type] !== false;
}

export function createPusher(o: { db: Db; log: Logger; subject: string; keyring?: Keyring | undefined; send?: SendFn }): Pusher {
  const send: SendFn = o.send ?? ((sub, payload, opts) => webpush.sendNotification(sub, payload, opts));
  let vapid: Promise<VapidKeys> | undefined;

  async function sendToUser(userId: string, type: AlertType, msg: PushMessage): Promise<PushOutcome> {
    const out: PushOutcome = { sent: 0, pruned: 0, failed: 0, skipped: false };
    if (!(await alertEnabled(o.db, userId, type))) return { ...out, skipped: true };
    const subs = await o.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
    if (!subs.length) return out;
    vapid ??= getOrCreateVapidKeys(o.db, o.subject, o.keyring);
    const keys = await vapid;
    const payload = JSON.stringify({ ...msg, type });
    for (const s of subs) {
      try {
        await send({ endpoint: s.endpoint, keys: s.keys }, payload, {
          vapidDetails: { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: 24 * 3600,
          ...(msg.tag ? { topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) } : {}),
        });
        out.sent++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await o.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
          out.pruned++;
        } else {
          out.failed++;
          o.log.warn({ userId, type, status, err: errInfo(e).message }, "push delivery failed");
        }
      }
    }
    return out;
  }

  const add = (a: PushOutcome, b: PushOutcome): PushOutcome => ({ sent: a.sent + b.sent, pruned: a.pruned + b.pruned, failed: a.failed + b.failed, skipped: a.skipped && b.skipped });
  async function sendToMany(ids: string[], type: AlertType, msg: PushMessage): Promise<PushOutcome> {
    let total: PushOutcome = { sent: 0, pruned: 0, failed: 0, skipped: ids.length > 0 };
    for (const id of ids) total = add(total, await sendToUser(id, type, msg));
    return total;
  }

  return {
    sendToUser,
    async sendToAdmins(type, msg) {
      const admins = await o.db.select({ id: users.id }).from(users).where(eq(users.role, "admin"));
      return sendToMany(admins.map((a) => a.id), type, msg);
    },
    async sendToAll(type, msg) {
      const all = await o.db.select({ id: users.id }).from(users);
      return sendToMany(all.map((a) => a.id), type, msg);
    },
  };
}
