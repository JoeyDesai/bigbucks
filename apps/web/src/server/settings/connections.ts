import "server-only";
/**
 * Settings → Connections (§7, §12.6). Credential storage matches the worker (apps/worker/src/secrets.ts):
 * `connections.enc_credentials` = encryptSecret(JSON.stringify(creds)), `credentials_last4` from the
 * secret's last 4 characters. Plaintext never leaves this module and is never returned to the client.
 *
 * Network: only connector `test()` calls (GET) and the one-time SimpleFIN claim POST (§4.6).
 */
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { checkSimplefinBudget, claimSetupToken, ConnectorError, createConnector, createYnabClient, parseAccessUrl } from "@homebase/connectors";
import { withTx, writeAudit, type Ctx } from "@homebase/core";
import { connections, decryptSecret, encryptSecret, last4, syncRuns, type Db } from "@homebase/db";
import { UserFacingError } from "./act";

export const CRED_SCHEMAS = {
  simplefin: z.object({ accessUrl: z.string().url() }),
  mercury: z.object({ token: z.string().min(8) }),
  ynab: z.object({ token: z.string().min(8) }),
  rentcast: z.object({ apiKey: z.string().min(8) }),
  coinbase: z.object({ keyName: z.string().min(1), privateKeyPem: z.string().min(16) }),
} as const;
export type CredProvider = keyof typeof CRED_SCHEMAS;

export const PROVIDER_LABEL: Record<CredProvider, string> = {
  simplefin: "SimpleFIN Bridge",
  mercury: "Mercury (business)",
  ynab: "YNAB (migration)",
  rentcast: "RentCast",
  coinbase: "Coinbase",
};

export const CredentialInputSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("simplefin"), connectionId: z.string().uuid().optional(), label: z.string().max(80).optional(), setupToken: z.string().trim().min(20, "Paste the whole setup token").max(4000) }),
  z.object({ provider: z.literal("mercury"), connectionId: z.string().uuid().optional(), label: z.string().max(80).optional(), token: z.string().trim().min(8).max(500) }),
  z.object({ provider: z.literal("ynab"), connectionId: z.string().uuid().optional(), label: z.string().max(80).optional(), token: z.string().trim().min(8).max(500) }),
  z.object({ provider: z.literal("rentcast"), connectionId: z.string().uuid().optional(), label: z.string().max(80).optional(), apiKey: z.string().trim().min(8).max(500) }),
  z.object({ provider: z.literal("coinbase"), connectionId: z.string().uuid().optional(), label: z.string().max(80).optional(), keyName: z.string().trim().min(1).max(300), privateKeyPem: z.string().trim().min(16).max(10_000) }),
]);
export type CredentialInput = z.input<typeof CredentialInputSchema>;

export function displayLast4(provider: CredProvider, creds: Record<string, string>): string {
  switch (provider) {
    case "simplefin":
      try {
        return last4(parseAccessUrl(creds.accessUrl!).password);
      } catch {
        return "";
      }
    case "mercury":
    case "ynab":
      return last4(creds.token!);
    case "rentcast":
      return last4(creds.apiKey!);
    case "coinbase":
      return last4(creds.keyName!);
  }
}

export interface ConnectionVM {
  id: string;
  provider: string;
  providerLabel: string;
  label: string;
  status: "ok" | "needs_attention" | "error" | "disabled";
  lastSuccessAt: string | null;
  lastError: string | null;
  last4: string | null;
  hasCredentials: boolean;
  requestsToday: number;
  manualToday: number;
  lastRun: { startedAt: string; status: string; added: number; updated: number } | null;
  issues: string[];
  inboxCount: number;
}

const DAY_START = sql`(date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')`;

export async function listConnections(db: Db): Promise<ConnectionVM[]> {
  const rows = await db
    .select({ id: connections.id, provider: connections.provider, label: connections.label, status: connections.status, lastSuccessAt: connections.lastSuccessAt, lastError: connections.lastError, last4: connections.credentialsLast4, hasCreds: sql<boolean>`${connections.encCredentials} IS NOT NULL`, meta: connections.meta })
    .from(connections)
    .orderBy(asc(connections.provider), asc(connections.createdAt));
  const usage = await db.execute<{ connection_id: string; total: number; manual: number }>(sql`
    SELECT connection_id, coalesce(sum(requests_used), 0)::int AS total,
      coalesce(sum(requests_used) FILTER (WHERE errors->>'trigger' = 'manual'), 0)::int AS manual
    FROM sync_runs WHERE started_at >= ${DAY_START} GROUP BY connection_id`);
  const last = await db.execute<{ connection_id: string; started_at: Date; status: string; tx_added: number; tx_updated: number }>(sql`
    SELECT DISTINCT ON (connection_id) connection_id, started_at, status, tx_added, tx_updated FROM sync_runs ORDER BY connection_id, started_at DESC`);
  const u = new Map(usage.rows.map((r) => [r.connection_id, r]));
  const l = new Map(last.rows.map((r) => [r.connection_id, r]));
  return rows.map((r) => {
    const meta = (r.meta ?? {}) as { issues?: { banner?: string; message?: string }[]; inbox?: unknown[] };
    const lr = l.get(r.id);
    return {
      id: r.id,
      provider: r.provider,
      providerLabel: PROVIDER_LABEL[r.provider as CredProvider] ?? r.provider,
      label: r.label,
      status: r.status,
      lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
      lastError: r.lastError,
      last4: r.last4,
      hasCredentials: !!r.hasCreds,
      requestsToday: u.get(r.id)?.total ?? 0,
      manualToday: u.get(r.id)?.manual ?? 0,
      lastRun: lr ? { startedAt: new Date(lr.started_at).toISOString(), status: lr.status, added: lr.tx_added, updated: lr.tx_updated } : null,
      issues: (meta.issues ?? []).map((i) => i.banner ?? i.message ?? "").filter(Boolean),
      inboxCount: Array.isArray(meta.inbox) ? meta.inbox.length : 0,
    };
  });
}

/** Store new credentials (or rotate an existing connection's). SimpleFIN setup tokens are claimed here. */
export async function addOrRotateConnection(db: Db, ctx: Ctx, raw: CredentialInput, deps: { claim?: typeof claimSetupToken } = {}): Promise<{ id: string; last4: string }> {
  const input = CredentialInputSchema.parse(raw);
  let creds: Record<string, string>;
  switch (input.provider) {
    case "simplefin":
      try {
        creds = { accessUrl: await (deps.claim ?? claimSetupToken)(input.setupToken) };
      } catch (e) {
        if (e instanceof ConnectorError) throw new UserFacingError(e.message);
        throw new UserFacingError("Couldn't claim that setup token. Check it was copied completely.");
      }
      break;
    case "mercury":
    case "ynab":
      creds = { token: input.token };
      break;
    case "rentcast":
      creds = { apiKey: input.apiKey };
      break;
    case "coinbase":
      creds = { keyName: input.keyName, privateKeyPem: input.privateKeyPem.replace(/\\n/g, "\n") };
      break;
  }
  const parsed = CRED_SCHEMAS[input.provider].parse(creds) as Record<string, string>;
  const enc = encryptSecret(JSON.stringify(parsed));
  const l4 = displayLast4(input.provider, parsed);
  return withTx(ctx, async (tx, c) => {
    let id = input.connectionId ?? null;
    if (id) {
      const [existing] = await tx.select({ provider: connections.provider }).from(connections).where(eq(connections.id, id));
      if (!existing) throw new UserFacingError("That connection no longer exists.");
      if (existing.provider !== input.provider) throw new UserFacingError("Credentials don't match this connection's provider.");
      await tx.update(connections).set({ encCredentials: enc, credentialsLast4: l4, status: "ok", lastError: null, updatedAt: new Date() }).where(eq(connections.id, id));
    } else {
      const [row] = await tx.insert(connections).values({ provider: input.provider, label: input.label?.trim() || PROVIDER_LABEL[input.provider], encCredentials: enc, credentialsLast4: l4, status: "ok", meta: {} }).returning({ id: connections.id });
      id = row!.id;
    }
    await writeAudit(tx, c, { action: input.connectionId ? "connection.rotate_credentials" : "connection.create", entity: "connection", entityId: id, after: { provider: input.provider, last4: l4 } });
    return { id, last4: l4 };
  });
}

export async function setConnectionDisabled(ctx: Ctx, id: string, disabled: boolean): Promise<void> {
  await withTx(ctx, async (tx, c) => {
    const [before] = await tx.select({ status: connections.status }).from(connections).where(eq(connections.id, id));
    if (!before) throw new UserFacingError("That connection no longer exists.");
    const status = disabled ? "disabled" : "ok";
    await tx.update(connections).set({ status, updatedAt: new Date() }).where(eq(connections.id, id));
    await writeAudit(tx, c, { action: disabled ? "connection.disable" : "connection.enable", entity: "connection", entityId: id, before, after: { status } });
  });
}

/**
 * Settings "Test" button. SimpleFIN tests spend one request of the daily budget (counted as manual,
 * like "Sync now", and recorded in sync_runs so the worker's budget sees it). RentCast is validated
 * locally because every call is metered.
 */
export async function testConnection(db: Db, ctx: Ctx, id: string): Promise<{ ok: boolean; message: string }> {
  const [row] = await db.select().from(connections).where(eq(connections.id, id));
  if (!row) throw new UserFacingError("That connection no longer exists.");
  if (!row.encCredentials) return { ok: false, message: "No credentials are stored for this connection." };
  const provider = row.provider as CredProvider;
  const schema = CRED_SCHEMAS[provider];
  if (!schema) return { ok: false, message: `There's no test for ${row.provider}.` };
  let creds: Record<string, string>;
  try {
    creds = schema.parse(JSON.parse(decryptSecret(row.encCredentials))) as Record<string, string>;
  } catch {
    return { ok: false, message: "Stored credentials can't be read (was HOMEBASE_MASTER_KEY changed?). Re-enter them." };
  }
  let result: { ok: boolean; message: string };
  if (provider === "simplefin") {
    const used = await db.execute<{ total: number; manual: number }>(sql`
      SELECT coalesce(sum(requests_used), 0)::int AS total, coalesce(sum(requests_used) FILTER (WHERE errors->>'trigger' = 'manual'), 0)::int AS manual
      FROM sync_runs WHERE connection_id = ${id} AND started_at >= ${DAY_START}`);
    const decision = checkSimplefinBudget({ usedToday: used.rows[0]?.total ?? 0, manualToday: used.rows[0]?.manual ?? 0 }, "manual");
    if (!decision.allowed) return { ok: false, message: `${decision.reason}. Try again tomorrow.` };
    const [run] = await db.insert(syncRuns).values({ connectionId: id, status: "running", requestsUsed: 1, errors: { trigger: "manual", issues: [], warnings: [], skipped: "settings test" } }).returning({ id: syncRuns.id });
    result = await createConnector("simplefin").test({ accessUrl: creds.accessUrl! });
    await db.update(syncRuns).set({ status: result.ok ? "ok" : "error", finishedAt: new Date() }).where(eq(syncRuns.id, run!.id));
  } else if (provider === "mercury") result = await createConnector("mercury").test({ token: creds.token! });
  else if (provider === "coinbase") result = await createConnector("coinbase").test({ keyName: creds.keyName!, privateKeyPem: creds.privateKeyPem! });
  else if (provider === "rentcast") result = { ok: creds.apiKey!.length >= 8, message: "Key stored (not verified: every RentCast call is metered, 5 a month)." };
  else {
    try {
      const plans = await createYnabClient(creds.token!).getPlans();
      result = { ok: true, message: `Connected: ${plans.plans.length} YNAB plan${plans.plans.length === 1 ? "" : "s"}` };
    } catch (e) {
      result = { ok: false, message: e instanceof Error ? e.message : "YNAB didn't accept the token." };
    }
  }
  await withTx(ctx, async (tx, c) => {
    await tx
      .update(connections)
      .set(result.ok ? { lastError: null, updatedAt: new Date(), ...(row.status === "error" ? { status: "ok" as const } : {}) } : { lastError: result.message.slice(0, 500), updatedAt: new Date() })
      .where(eq(connections.id, id));
    await writeAudit(tx, c, { action: "connection.test", entity: "connection", entityId: id, after: { ok: result.ok } });
  });
  return { ok: result.ok, message: result.message };
}
