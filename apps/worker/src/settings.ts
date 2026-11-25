/**
 * Typed access to the `settings` key/value table. Secret values go in `enc_value` (AES-256-GCM via
 * @homebase/db crypto) and are never returned by `getSetting`.
 *
 * Keys owned by the worker (see docs/decisions.md "Worker: settings keys"):
 *   sync_start_date      "YYYY-MM-DD" — §10 sync start; set on the first SimpleFIN/Mercury sync if absent
 *   ynab_import          { plan_id, plan_name, server_knowledge, imported_at, last_delta_at? }
 *   ynab_cutover_date    "YYYY-MM-DD" — set by Settings at cutover; stops ynab.delta and shadow mode
 *   categorizer_shadow   boolean — explicit override of shadow mode (default: on during the parallel run)
 *   push_vapid           { public_key, subject } + enc_value = private key
 *   push_preferences     { [userId]: { [alertType]: boolean } } — missing = enabled
 *   digest_latest        { conversation_id, message_id, week_end, title }
 *   ynab_ui_snapshot     { file, month, openingMonth, categoryIds, … } — what import:ynab-snapshot wrote (undo record)
 */
import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret, settings, type Db, type Keyring, type Tx } from "@homebase/db";

type DbLike = Db | Tx;

export const SETTING_KEYS = {
  syncStartDate: "sync_start_date",
  ynabImport: "ynab_import",
  ynabCutoverDate: "ynab_cutover_date",
  categorizerShadow: "categorizer_shadow",
  pushVapid: "push_vapid",
  pushPreferences: "push_preferences",
  digestLatest: "digest_latest",
  ynabUiSnapshot: "ynab_ui_snapshot",
} as const;

export interface YnabImportSetting {
  plan_id: string;
  plan_name: string;
  server_knowledge: number | null;
  imported_at: string;
  last_delta_at?: string;
}

export async function getSetting<T>(db: DbLike, key: string): Promise<T | undefined> {
  const rows = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  const v = rows[0]?.value;
  return v === null || v === undefined ? undefined : (v as T);
}

export async function setSetting(db: DbLike, key: string, value: unknown): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
}

export async function getSecretSetting(db: DbLike, key: string, keyring?: Keyring): Promise<{ value: unknown; secret: string | null } | undefined> {
  const rows = await db.select({ value: settings.value, enc: settings.encValue }).from(settings).where(eq(settings.key, key));
  const r = rows[0];
  if (!r) return undefined;
  return { value: r.value, secret: r.enc ? decryptSecret(r.enc, keyring) : null };
}

export async function setSecretSetting(db: DbLike, key: string, value: unknown, secret: string, keyring?: Keyring): Promise<void> {
  const encValue = encryptSecret(secret, keyring);
  await db
    .insert(settings)
    .values({ key, value, encValue })
    .onConflictDoUpdate({ target: settings.key, set: { value, encValue, updatedAt: new Date() } });
}

/** §10 parallel run: a YNAB import exists and no cutover date has been set (or it is in the future). */
export async function parallelRunState(db: DbLike, today: string): Promise<{ imported: boolean; cutover: string | null; active: boolean }> {
  const imp = await getSetting<YnabImportSetting>(db, SETTING_KEYS.ynabImport);
  const cutover = (await getSetting<string>(db, SETTING_KEYS.ynabCutoverDate)) ?? null;
  const cut = cutover !== null && cutover <= today;
  return { imported: !!imp, cutover, active: !!imp && !cut };
}

/** Shadow mode for the categorizer: explicit setting wins; otherwise on while the parallel run is active. */
export async function categorizerShadowMode(db: DbLike, today: string): Promise<boolean> {
  const explicit = await getSetting<boolean>(db, SETTING_KEYS.categorizerShadow);
  if (typeof explicit === "boolean") return explicit;
  return (await parallelRunState(db, today)).active;
}
