/**
 * sync.rentcast (§7.6): 2nd of the month 09:00 plus manual refresh. Hard cap 5 calls/month counted
 * from sync_runs. Each `assets` row of kind home with an address gets an `asset_valuations` row and its
 * `property` tracking account gets today's balance (created and linked if missing).
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { accounts, assetValuations, assets, balances, type Connection } from "@homebase/db";
import { RENTCAST_MONTHLY_CAP, checkRentcastBudget, createRentcastConnector } from "@homebase/connectors";
import { todayOf, type WorkerContext } from "../../context";
import { ensureEntity, HOUSEHOLD_ENTITY } from "../../ingest/accounts";
import { addRequests, finishSyncRun, markConnectionNeedsAttention, markConnectionOk, requestsThisMonth, saveRawPayload, startSyncRun, toJsonSafe, type SyncRunErrors, type SyncTrigger } from "../../ingest/syncRuns";
import { loadConnections, type CredsFor } from "../../secrets";
import { countingHttp, forEachConnection, secretsDeps, type SyncSummary } from "../common";

export async function syncRentcast(ctx: WorkerContext, o: { trigger: SyncTrigger }): Promise<SyncSummary[]> {
  const conns = await loadConnections(secretsDeps(ctx), "rentcast");
  return forEachConnection(ctx, "rentcast", conns, ({ connection, creds }) => syncRentcastConnection(ctx, connection, creds, o.trigger));
}

export async function syncRentcastConnection(ctx: WorkerContext, connection: Connection, creds: CredsFor<"rentcast">, trigger: SyncTrigger): Promise<SyncSummary> {
  const today = todayOf(ctx);
  const homes = await ctx.db.select().from(assets).where(and(eq(assets.kind, "home"), isNotNull(assets.address)));
  const summary: SyncSummary = { connectionId: connection.id, provider: "rentcast", status: "ok", requestsUsed: 0 };
  if (!homes.length) return { ...summary, status: "skipped", reason: "no home asset with an address" };

  const used = await requestsThisMonth(ctx.db, connection.id, ctx.now());
  const runId = await startSyncRun(ctx.db, connection.id, trigger, ctx.now());
  const errors: SyncRunErrors = { trigger, issues: [], warnings: [] };
  const http = countingHttp(ctx.http, async () => {
    summary.requestsUsed++;
    await addRequests(ctx.db, runId, 1);
  });
  const connector = createRentcastConnector({ http: { ...http, retries: 0 }, now: ctx.now });
  let valued = 0;
  try {
    for (const home of homes) {
      if (!checkRentcastBudget(used + summary.requestsUsed, RENTCAST_MONTHLY_CAP).allowed) {
        errors.skipped = `RentCast monthly cap of ${RENTCAST_MONTHLY_CAP} reached`;
        break;
      }
      const v = await connector.valuate({ apiKey: creds.apiKey, property: { address: home.address! } });
      await saveRawPayload(ctx.db, runId, "rentcast", v.raw, ctx.now());
      await ctx.db
        .insert(assetValuations)
        .values({ assetId: home.id, asOf: today, valueMilli: v.price, lowMilli: v.priceRangeLow ?? null, highMilli: v.priceRangeHigh ?? null, source: "rentcast", comps: toJsonSafe(v.comparables) })
        .onConflictDoUpdate({
          target: [assetValuations.assetId, assetValuations.asOf, assetValuations.source],
          set: { valueMilli: v.price, lowMilli: v.priceRangeLow ?? null, highMilli: v.priceRangeHigh ?? null, comps: toJsonSafe(v.comparables), updatedAt: ctx.now() },
        });
      let accountId = home.accountId;
      if (!accountId) {
        const entityId = await ctx.db.transaction((tx) => ensureEntity(tx, HOUSEHOLD_ENTITY));
        const [a] = await ctx.db
          .insert(accounts)
          .values({ entityId, name: home.name, kind: "property", onBudget: false, source: "rentcast", connectionId: connection.id, externalId: `rentcast:${home.id}`, institution: "RentCast" })
          .returning({ id: accounts.id });
        accountId = a!.id;
        await ctx.db.update(assets).set({ accountId, updatedAt: ctx.now() }).where(eq(assets.id, home.id));
      }
      await ctx.db
        .insert(balances)
        .values({ accountId, asOf: today, currentMilli: v.price, source: "rentcast" })
        .onConflictDoUpdate({ target: [balances.accountId, balances.asOf], set: { currentMilli: v.price, source: "rentcast", updatedAt: ctx.now() } });
      valued++;
    }
    await finishSyncRun(ctx.db, runId, { status: errors.skipped ? "partial" : "ok", accountsSeen: valued, errors, finishedAt: ctx.now() });
    await markConnectionOk(ctx.db, connection.id, ctx.now());
    return { ...summary, status: valued ? "ok" : "skipped", ...(errors.skipped ? { reason: errors.skipped } : {}), accountsSeen: valued };
  } catch (e) {
    errors.error = (e as Error).message;
    await finishSyncRun(ctx.db, runId, { status: "error", errors, finishedAt: ctx.now() });
    const status = (e as { status?: number }).status;
    if (status === 401 || status === 403) {
      await markConnectionNeedsAttention(ctx.db, connection, `RentCast rejected the API key (HTTP ${status})`, ctx.now());
      return { ...summary, status: "needs_attention", reason: errors.error };
    }
    throw e;
  }
}
