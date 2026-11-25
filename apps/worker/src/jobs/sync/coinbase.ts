/**
 * sync.coinbase (§7.3): daily 23:05. One "Coinbase" crypto tracking account (USD = Σ native_balance)
 * plus one `holdings` row per non-zero wallet. Transactions are not pulled on the schedule: they are
 * display-only history and cost one request per wallet (TODO: on-demand history import).
 */
import type { Connection } from "@homebase/db";
import { createCoinbaseConnector } from "@homebase/connectors";
import type { WorkerContext } from "../../context";
import { afterIngest, HOUSEHOLD_ENTITY, ingestBatch } from "../../ingest";
import { addRequests, finishSyncRun, markConnectionNeedsAttention, markConnectionOk, saveRawPayload, startSyncRun, type SyncRunErrors, type SyncTrigger } from "../../ingest/syncRuns";
import { loadConnections, type CredsFor } from "../../secrets";
import { countingHttp, forEachConnection, secretsDeps, type SyncSummary } from "../common";

export async function syncCoinbase(ctx: WorkerContext, o: { trigger: SyncTrigger }): Promise<SyncSummary[]> {
  const conns = await loadConnections(secretsDeps(ctx), "coinbase");
  return forEachConnection(ctx, "coinbase", conns, ({ connection, creds }) => syncCoinbaseConnection(ctx, connection, creds, o.trigger));
}

export async function syncCoinbaseConnection(ctx: WorkerContext, connection: Connection, creds: CredsFor<"coinbase">, trigger: SyncTrigger): Promise<SyncSummary> {
  const runId = await startSyncRun(ctx.db, connection.id, trigger, ctx.now());
  const errors: SyncRunErrors = { trigger, issues: [], warnings: [] };
  let requests = 0;
  const http = countingHttp(ctx.http, async () => {
    requests++;
    await addRequests(ctx.db, runId, 1);
  });
  const connector = createCoinbaseConnector({ http, now: () => ctx.now().getTime() });
  try {
    const accts = await connector.listAccounts(creds);
    const holdings = (await connector.fetchHoldings?.(creds)) ?? [];
    await saveRawPayload(ctx.db, runId, "coinbase", { accounts: accts.map((a) => a.raw), holdings: holdings.map((h) => h.raw) }, ctx.now());
    const r = await ingestBatch(ctx, { connection, source: "coinbase", entity: HOUSEHOLD_ENTITY, accounts: accts, transactions: [], holdings });
    await finishSyncRun(ctx.db, runId, { status: "ok", accountsSeen: r.accountsSeen, errors, finishedAt: ctx.now() });
    await markConnectionOk(ctx.db, connection.id, ctx.now());
    await afterIngest(ctx, r);
    return { connectionId: connection.id, provider: "coinbase", status: "ok", requestsUsed: requests, accountsSeen: r.accountsSeen, newInboxAccounts: r.inboxAccounts.length };
  } catch (e) {
    errors.error = (e as Error).message;
    await finishSyncRun(ctx.db, runId, { status: "error", errors, finishedAt: ctx.now() });
    const status = (e as { status?: number }).status;
    if (status === 401 || status === 403 || (e as { code?: string }).code === "invalid_input") {
      await markConnectionNeedsAttention(ctx.db, connection, `Coinbase rejected the API key: ${errors.error}`, ctx.now());
      return { connectionId: connection.id, provider: "coinbase", status: "needs_attention", reason: errors.error, requestsUsed: requests };
    }
    throw e;
  }
}
