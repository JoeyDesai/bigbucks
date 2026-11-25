/**
 * `sync_runs` bookkeeping, `raw_payloads` (14-day retention) and connection health.
 *
 * `sync_runs.errors` is a structured object (not just a list) so request budgets can tell manual
 * from scheduled runs: { trigger, issues: [...], warnings: [...], error?: string }.
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { connections, rawPayloads, syncRuns, type Connection, type Db, type Tx } from "@homebase/db";
import { localMidnightEpoch, type SimplefinIssue } from "@homebase/connectors";
import { toLocalDate } from "@homebase/shared";

type DbLike = Db | Tx;

export type SyncTrigger = "scheduled" | "manual" | "cli";

export interface SyncRunErrors {
  trigger: SyncTrigger;
  issues: Array<{ code: string; msg: string; status?: string; connId?: string; accountId?: string; banner?: string }>;
  warnings: string[];
  error?: string;
  skipped?: string;
}

export const RAW_PAYLOAD_RETENTION_DAYS = 14;

export async function startSyncRun(db: DbLike, connectionId: string, trigger: SyncTrigger, now: Date): Promise<string> {
  const errors: SyncRunErrors = { trigger, issues: [], warnings: [] };
  const [row] = await db.insert(syncRuns).values({ connectionId, startedAt: now, status: "running", errors }).returning({ id: syncRuns.id });
  return row!.id;
}

/** Count a request against the budget immediately (so a crash mid-run still counts). */
export async function addRequests(db: DbLike, runId: string, n = 1): Promise<void> {
  await db.update(syncRuns).set({ requestsUsed: sql`${syncRuns.requestsUsed} + ${n}` }).where(eq(syncRuns.id, runId));
}

export async function finishSyncRun(
  db: DbLike,
  runId: string,
  r: { status: "ok" | "partial" | "error"; accountsSeen?: number; txAdded?: number; txUpdated?: number; errors: SyncRunErrors; finishedAt: Date },
): Promise<void> {
  await db
    .update(syncRuns)
    .set({ status: r.status, finishedAt: r.finishedAt, accountsSeen: r.accountsSeen ?? 0, txAdded: r.txAdded ?? 0, txUpdated: r.txUpdated ?? 0, errors: r.errors })
    .where(eq(syncRuns.id, runId));
}

export async function saveRawPayload(db: DbLike, runId: string, provider: Connection["provider"], body: unknown, fetchedAt: Date): Promise<void> {
  await db.insert(rawPayloads).values({ syncRunId: runId, provider, fetchedAt, body: toJsonSafe(body) });
}

/** Delete raw payloads older than 14 days. Returns the number removed. */
export async function purgeRawPayloads(db: DbLike, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - RAW_PAYLOAD_RETENTION_DAYS * 86_400_000);
  const rows = await db.delete(rawPayloads).where(lt(rawPayloads.fetchedAt, cutoff)).returning({ id: rawPayloads.id });
  return rows.length;
}

/** Requests used today (local America/New_York day) on one connection, split by trigger. */
export async function requestsToday(db: DbLike, connectionId: string, now: Date): Promise<{ usedToday: number; manualToday: number }> {
  const since = new Date(localMidnightEpoch(toLocalDate(now)) * 1000);
  const rows = await db
    .select({ used: syncRuns.requestsUsed, errors: syncRuns.errors })
    .from(syncRuns)
    .where(and(eq(syncRuns.connectionId, connectionId), gte(syncRuns.startedAt, since)));
  let usedToday = 0;
  let manualToday = 0;
  for (const r of rows) {
    usedToday += r.used;
    if ((r.errors as SyncRunErrors | null)?.trigger === "manual") manualToday += r.used;
  }
  return { usedToday, manualToday };
}

/** Requests used this calendar month (local) on one connection (RentCast cap). */
export async function requestsThisMonth(db: DbLike, connectionId: string, now: Date): Promise<number> {
  const since = new Date(localMidnightEpoch(`${toLocalDate(now).slice(0, 8)}01`) * 1000);
  const rows = await db
    .select({ n: sql<number>`coalesce(sum(${syncRuns.requestsUsed}), 0)::int` })
    .from(syncRuns)
    .where(and(eq(syncRuns.connectionId, connectionId), gte(syncRuns.startedAt, since)));
  return Number(rows[0]?.n ?? 0);
}

export interface ConnectionMeta {
  /** Accounts created by sync that await review in the "New accounts" inbox (§8.2). */
  inbox?: Array<{ accountId: string; externalId: string; name: string; kindGuess: string; detectedAt: string }>;
  /** externalId → existing account, or creation settings that bypass the inbox. */
  accountMap?: Record<string, { accountId?: string; name?: string; kind?: string; onBudget?: boolean; entity?: string }>;
  /** When status first became needs_attention (health.connections pushes after 24 h). */
  needsAttentionSince?: string | null;
  /** SimpleFIN per-institution banners ("Reconnect Contoso Bank in SimpleFIN"). */
  issues?: SyncRunErrors["issues"];
  /** SimpleFIN initial backfill progress (§7.1). */
  backfill?: { target: string; coveredFrom: string | null; done: boolean };
  [k: string]: unknown;
}

export function metaOf(c: Pick<Connection, "meta">): ConnectionMeta {
  return (c.meta && typeof c.meta === "object" ? (c.meta as ConnectionMeta) : {}) ?? {};
}

export async function patchConnectionMeta(db: DbLike, connectionId: string, patch: Partial<ConnectionMeta>): Promise<void> {
  await db
    .update(connections)
    .set({ meta: sql`coalesce(${connections.meta}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
    .where(eq(connections.id, connectionId));
}

/** Healthy sync: status ok, last_success_at now, needs-attention bookkeeping cleared. */
export async function markConnectionOk(db: DbLike, connectionId: string, now: Date, issues: SyncRunErrors["issues"] = []): Promise<void> {
  await db.update(connections).set({ status: "ok", lastSuccessAt: now, lastError: null, updatedAt: now }).where(eq(connections.id, connectionId));
  await patchConnectionMeta(db, connectionId, { needsAttentionSince: null, issues });
}

/** con.auth / revoked / lapsed: the user must act. Keeps the earliest needs-attention timestamp. */
export async function markConnectionNeedsAttention(db: DbLike, c: Connection, message: string, now: Date, issues: SyncRunErrors["issues"] = []): Promise<void> {
  const meta = metaOf(c);
  await db.update(connections).set({ status: "needs_attention", lastError: message, updatedAt: now }).where(eq(connections.id, c.id));
  await patchConnectionMeta(db, c.id, { needsAttentionSince: meta.needsAttentionSince ?? now.toISOString(), issues });
}

/** Final retry exhausted (§8.1). */
export async function markConnectionError(db: DbLike, connectionId: string, message: string, now: Date): Promise<void> {
  await db.update(connections).set({ status: "error", lastError: message.slice(0, 500), updatedAt: now }).where(eq(connections.id, connectionId));
}

export function issuesToJson(issues: SimplefinIssue[]): SyncRunErrors["issues"] {
  return issues.map((i) => {
    const o: SyncRunErrors["issues"][number] = { code: i.code, msg: i.msg, status: i.status };
    if (i.connId) o.connId = i.connId;
    if (i.accountId) o.accountId = i.accountId;
    if (i.banner) o.banner = i.banner;
    return o;
  });
}

/** JSON-safe copy (bigint → string) for jsonb columns. */
export function toJsonSafe(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}
