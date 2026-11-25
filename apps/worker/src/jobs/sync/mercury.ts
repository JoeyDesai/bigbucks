/**
 * sync.mercury (§7.2): hourly at :07, 07:00–22:00. Business entity, tracking (off-budget) accounts.
 * No published rate limit; the HTTP client backs off on 429. Window: last 14 days (initial run:
 * 30 days before sync start, like SimpleFIN).
 */
import type { Connection } from "@homebase/db";
import { createMercuryConnector } from "@homebase/connectors";
import { addDays } from "@homebase/shared";
import { todayOf, type WorkerContext } from "../../context";
import { afterIngest, BUSINESS_ENTITY, ingestBatch } from "../../ingest";
import { addRequests, finishSyncRun, markConnectionNeedsAttention, markConnectionOk, metaOf, patchConnectionMeta, purgeRawPayloads, saveRawPayload, startSyncRun, type SyncRunErrors, type SyncTrigger } from "../../ingest/syncRuns";
import { loadConnections, type CredsFor } from "../../secrets";
import { countingHttp, forEachConnection, secretsDeps, type SyncSummary } from "../common";
import { ensureSyncStart } from "./simplefin";

export async function syncMercury(ctx: WorkerContext, o: { trigger: SyncTrigger }): Promise<SyncSummary[]> {
  const conns = await loadConnections(secretsDeps(ctx), "mercury");
  return forEachConnection(ctx, "mercury", conns, ({ connection, creds }) => syncMercuryConnection(ctx, connection, creds, o.trigger));
}

export async function syncMercuryConnection(ctx: WorkerContext, connection: Connection, creds: CredsFor<"mercury">, trigger: SyncTrigger): Promise<SyncSummary> {
  const today = todayOf(ctx);
  const syncStart = await ensureSyncStart(ctx);
  const meta = metaOf(connection);
  const since = meta.backfill?.done ? addDays(today, -14) : addDays(syncStart, -30);
  const runId = await startSyncRun(ctx.db, connection.id, trigger, ctx.now());
  const errors: SyncRunErrors = { trigger, issues: [], warnings: [] };
  let requests = 0;
  const http = countingHttp(ctx.http, async () => {
    requests++;
    await addRequests(ctx.db, runId, 1);
  });
  const connector = createMercuryConnector({ http, now: ctx.now });
  try {
    const accts = await connector.listAccounts(creds);
    const txns = await connector.fetchTransactions(creds, { since, until: today });
    await saveRawPayload(ctx.db, runId, "mercury", { accounts: accts.map((a) => a.raw), transactions: txns.map((t) => t.raw) }, ctx.now());
    const r = await ingestBatch(ctx, { connection, source: "mercury", entity: BUSINESS_ENTITY, accounts: accts, transactions: txns, window: { since, until: today } });
    if (!meta.backfill?.done) await patchConnectionMeta(ctx.db, connection.id, { backfill: { target: since, coveredFrom: since, done: true } });
    await finishSyncRun(ctx.db, runId, { status: "ok", accountsSeen: r.accountsSeen, txAdded: r.added, txUpdated: r.updated, errors, finishedAt: ctx.now() });
    await markConnectionOk(ctx.db, connection.id, ctx.now());
    await purgeRawPayloads(ctx.db, ctx.now());
    await afterIngest(ctx, r);
    return { connectionId: connection.id, provider: "mercury", status: "ok", requestsUsed: requests, accountsSeen: r.accountsSeen, txAdded: r.added, txUpdated: r.updated, newInboxAccounts: r.inboxAccounts.length };
  } catch (e) {
    errors.error = (e as Error).message;
    await finishSyncRun(ctx.db, runId, { status: "error", errors, finishedAt: ctx.now() });
    const status = (e as { status?: number }).status;
    if (status === 401 || status === 403) {
      await markConnectionNeedsAttention(ctx.db, connection, `Mercury rejected the API token (HTTP ${status}); replace it in Settings`, ctx.now());
      return { connectionId: connection.id, provider: "mercury", status: "needs_attention", reason: errors.error, requestsUsed: requests };
    }
    throw e;
  }
}
