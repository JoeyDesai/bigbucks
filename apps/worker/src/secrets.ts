/**
 * Connector credentials (§4.6). Source of truth is `connections.enc_credentials` (AES-256-GCM via
 * @homebase/db). Bootstrap env vars are only used when no connection row for that provider holds
 * credentials yet; they are then encrypted into a new row so Settings → Connections can manage them.
 *
 * Nothing here logs or returns secret values except to the caller that needs them for a request.
 */
import { and, asc, eq, isNotNull, ne } from "drizzle-orm";
import { z } from "zod";
import { connections, decryptSecret, encryptSecret, last4, type Connection, type Db, type Keyring } from "@homebase/db";
import { parseAccessUrl } from "@homebase/connectors";
import type { Logger } from "./log";
import type { WorkerEnv } from "./env";

function parseAccessUrlSafe(u: string): { password: string } | null {
  try {
    return parseAccessUrl(u);
  } catch {
    return null;
  }
}

export const SimplefinCredsSchema = z.object({ accessUrl: z.string().url() });
export const MercuryCredsSchema = z.object({ token: z.string().min(8) });
export const YnabCredsSchema = z.object({ token: z.string().min(8) });
export const RentcastCredsSchema = z.object({ apiKey: z.string().min(8) });
export const CoinbaseCredsSchema = z.object({ keyName: z.string().min(1), privateKeyPem: z.string().min(16) });

export const CRED_SCHEMAS = {
  simplefin: SimplefinCredsSchema,
  mercury: MercuryCredsSchema,
  ynab: YnabCredsSchema,
  rentcast: RentcastCredsSchema,
  coinbase: CoinbaseCredsSchema,
} as const;

export type CredProvider = keyof typeof CRED_SCHEMAS;
export type CredsFor<P extends CredProvider> = z.infer<(typeof CRED_SCHEMAS)[P]>;

const DEFAULT_LABELS: Record<CredProvider, string> = {
  simplefin: "SimpleFIN Bridge",
  mercury: "Mercury (business)",
  ynab: "YNAB (migration)",
  rentcast: "RentCast",
  coinbase: "Coinbase",
};

/** Credentials described by bootstrap env vars, if any. */
export function envCredentials(env: Pick<WorkerEnv, "SIMPLEFIN_ACCESS_URL" | "MERCURY_TOKEN" | "YNAB_TOKEN" | "RENTCAST_API_KEY" | "COINBASE_KEY_NAME" | "COINBASE_PRIVATE_KEY">): Partial<{ [P in CredProvider]: CredsFor<P> }> {
  const out: Partial<{ [P in CredProvider]: CredsFor<P> }> = {};
  if (env.SIMPLEFIN_ACCESS_URL) out.simplefin = { accessUrl: env.SIMPLEFIN_ACCESS_URL };
  if (env.MERCURY_TOKEN) out.mercury = { token: env.MERCURY_TOKEN };
  if (env.YNAB_TOKEN) out.ynab = { token: env.YNAB_TOKEN };
  if (env.RENTCAST_API_KEY) out.rentcast = { apiKey: env.RENTCAST_API_KEY };
  if (env.COINBASE_KEY_NAME && env.COINBASE_PRIVATE_KEY) out.coinbase = { keyName: env.COINBASE_KEY_NAME, privateKeyPem: env.COINBASE_PRIVATE_KEY };
  return out;
}

/** The characters shown in Settings (§4.6: last 4 only). For SimpleFIN, the access password's last 4. */
export function displayLast4(provider: CredProvider, creds: unknown): string {
  switch (provider) {
    case "simplefin": {
      const p = parseAccessUrlSafe((creds as CredsFor<"simplefin">).accessUrl);
      return p ? last4(p.password) : "";
    }
    case "mercury":
    case "ynab":
      return last4((creds as { token: string }).token);
    case "rentcast":
      return last4((creds as CredsFor<"rentcast">).apiKey);
    case "coinbase":
      return last4((creds as CredsFor<"coinbase">).keyName);
  }
}

export function encryptCredentials(creds: unknown, keyring?: Keyring): Buffer {
  return encryptSecret(JSON.stringify(creds), keyring);
}

export function decryptCredentials<P extends CredProvider>(provider: P, enc: Buffer | Uint8Array, keyring?: Keyring): CredsFor<P> {
  let json: unknown;
  try {
    json = JSON.parse(decryptSecret(enc, keyring));
  } catch (e) {
    // decryptSecret's messages never include plaintext; JSON errors could, so replace them.
    throw new Error(`stored ${provider} credentials could not be read${e instanceof SyntaxError ? " (not JSON)" : `: ${(e as Error).message}`}`);
  }
  const r = CRED_SCHEMAS[provider].safeParse(json);
  if (!r.success) throw new Error(`stored ${provider} credentials have the wrong shape (${r.error.issues.map((i) => i.path.join(".")).join(", ")})`);
  return r.data as CredsFor<P>;
}

export interface LoadedConnection<P extends CredProvider> {
  connection: Connection;
  creds: CredsFor<P>;
}

export interface SecretsDeps {
  db: Db;
  log: Logger;
  keyring?: Keyring | undefined;
  env: Pick<WorkerEnv, "SIMPLEFIN_ACCESS_URL" | "MERCURY_TOKEN" | "YNAB_TOKEN" | "RENTCAST_API_KEY" | "COINBASE_KEY_NAME" | "COINBASE_PRIVATE_KEY">;
}

/**
 * First run: for each provider with bootstrap env credentials and no connection row holding
 * credentials, insert an encrypted `connections` row. Existing rows always win over env.
 */
export async function bootstrapConnections(d: SecretsDeps): Promise<CredProvider[]> {
  const created: CredProvider[] = [];
  const fromEnv = envCredentials(d.env);
  for (const provider of Object.keys(fromEnv) as CredProvider[]) {
    const creds = fromEnv[provider]!;
    const parsed = CRED_SCHEMAS[provider].safeParse(creds);
    if (!parsed.success) {
      d.log.warn({ provider }, "bootstrap credentials in env are malformed; ignoring");
      continue;
    }
    const existing = await d.db
      .select({ id: connections.id, enc: connections.encCredentials })
      .from(connections)
      .where(eq(connections.provider, provider))
      .orderBy(asc(connections.createdAt));
    if (existing.some((c) => c.enc)) continue;
    const enc = encryptCredentials(parsed.data, d.keyring);
    const credentialsLast4 = displayLast4(provider, parsed.data);
    if (existing[0]) {
      await d.db.update(connections).set({ encCredentials: enc, credentialsLast4, updatedAt: new Date() }).where(eq(connections.id, existing[0].id));
    } else {
      await d.db.insert(connections).values({ provider, label: DEFAULT_LABELS[provider], encCredentials: enc, credentialsLast4, status: "ok", meta: { bootstrapped_from_env: true } });
    }
    created.push(provider);
    d.log.info({ provider }, "stored bootstrap credentials from env in an encrypted connection row");
  }
  return created;
}

/** All enabled connections for a provider that hold credentials, decrypted. Bad rows are logged and skipped. */
export async function loadConnections<P extends CredProvider>(d: SecretsDeps, provider: P): Promise<LoadedConnection<P>[]> {
  await bootstrapConnections({ ...d, env: onlyProvider(d.env, provider) });
  const rows = await d.db
    .select()
    .from(connections)
    .where(and(eq(connections.provider, provider), ne(connections.status, "disabled"), isNotNull(connections.encCredentials)))
    .orderBy(asc(connections.createdAt));
  const out: LoadedConnection<P>[] = [];
  for (const row of rows) {
    try {
      out.push({ connection: row, creds: decryptCredentials(provider, row.encCredentials!, d.keyring) });
    } catch (e) {
      d.log.error({ provider, connectionId: row.id, err: (e as Error).message }, "cannot decrypt connection credentials");
      await d.db.update(connections).set({ status: "error", lastError: (e as Error).message, updatedAt: new Date() }).where(eq(connections.id, row.id));
    }
  }
  return out;
}

/** Store (or replace) credentials on a connection row, e.g. after a SimpleFIN claim. Returns the row id. */
export async function storeCredentials<P extends CredProvider>(d: Pick<SecretsDeps, "db" | "keyring">, provider: P, creds: CredsFor<P>, o: { connectionId?: string; label?: string } = {}): Promise<string> {
  const parsed = CRED_SCHEMAS[provider].parse(creds);
  const enc = encryptCredentials(parsed, d.keyring);
  const credentialsLast4 = displayLast4(provider, parsed);
  if (o.connectionId) {
    await d.db.update(connections).set({ encCredentials: enc, credentialsLast4, status: "ok", lastError: null, updatedAt: new Date() }).where(eq(connections.id, o.connectionId));
    return o.connectionId;
  }
  const [row] = await d.db.insert(connections).values({ provider, label: o.label ?? DEFAULT_LABELS[provider], encCredentials: enc, credentialsLast4, status: "ok", meta: {} }).returning({ id: connections.id });
  return row!.id;
}

function onlyProvider(env: SecretsDeps["env"], provider: CredProvider): SecretsDeps["env"] {
  const keys: Record<CredProvider, (keyof SecretsDeps["env"])[]> = {
    simplefin: ["SIMPLEFIN_ACCESS_URL"],
    mercury: ["MERCURY_TOKEN"],
    ynab: ["YNAB_TOKEN"],
    rentcast: ["RENTCAST_API_KEY"],
    coinbase: ["COINBASE_KEY_NAME", "COINBASE_PRIVATE_KEY"],
  };
  const out: SecretsDeps["env"] = {};
  for (const k of keys[provider]) if (env[k]) out[k] = env[k];
  return out;
}
