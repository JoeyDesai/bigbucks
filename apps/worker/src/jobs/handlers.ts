/** Job name → handler. Each handler is idempotent; pg-boss provides retries and single-instance. */
import { z } from "zod";
import type { WorkerContext } from "../context";
import type { SyncTrigger } from "../ingest/syncRuns";
import { MANUAL_SYNC_PROVIDERS, type ManualSyncProvider } from "./definitions";
import { priceManual } from "./manualPrices";
import { runWeeklyDigest } from "./digest";
import { snapshotNetworth } from "./networth";
import { runBackupCheck, runCategorize, runConnectionHealth } from "./ops";
import { materializeScheduled } from "./scheduled";
import { syncCoinbase } from "./sync/coinbase";
import { syncMercury } from "./sync/mercury";
import { syncRentcast } from "./sync/rentcast";
import { syncSimplefin } from "./sync/simplefin";
import { runYnabDelta } from "./ynabDelta";

export type JobHandler = (ctx: WorkerContext, data: unknown) => Promise<unknown>;

const SyncData = z.object({ trigger: z.enum(["scheduled", "manual", "cli"]).default("scheduled") }).passthrough();
const ManualData = z.object({ provider: z.enum(MANUAL_SYNC_PROVIDERS), userId: z.string().uuid().optional() });
const CategorizeData = z.object({ transactionIds: z.array(z.string().uuid()).optional() }).passthrough();

const trig = (data: unknown): SyncTrigger => SyncData.parse(data ?? {}).trigger;

/** "Sync now" for one provider. SimpleFIN applies the manual cap (2/day) inside its budget check. */
export async function runManualSync(ctx: WorkerContext, provider: ManualSyncProvider, trigger: SyncTrigger = "manual"): Promise<unknown> {
  switch (provider) {
    case "simplefin":
      return syncSimplefin(ctx, { trigger });
    case "mercury":
      return syncMercury(ctx, { trigger });
    case "coinbase":
      return syncCoinbase(ctx, { trigger });
    case "rentcast":
      return syncRentcast(ctx, { trigger });
    case "ynab":
      return runYnabDelta(ctx, { trigger });
  }
}

export const HANDLERS: Record<string, JobHandler> = {
  "sync.simplefin": (ctx, d) => syncSimplefin(ctx, { trigger: trig(d) }),
  "sync.mercury": (ctx, d) => syncMercury(ctx, { trigger: trig(d) }),
  "sync.coinbase": (ctx, d) => syncCoinbase(ctx, { trigger: trig(d) }),
  "sync.rentcast": (ctx, d) => syncRentcast(ctx, { trigger: trig(d) }),
  "sync.manual": (ctx, d) => runManualSync(ctx, ManualData.parse(d).provider),
  "ynab.delta": (ctx, d) => runYnabDelta(ctx, { trigger: trig(d) }),
  "categorize.pending": (ctx, d) => runCategorize(ctx, "pending", CategorizeData.parse(d ?? {})),
  "categorize.batch": (ctx) => runCategorize(ctx, "batch"),
  "price.manual": (ctx) => priceManual(ctx),
  "snapshot.networth": (ctx) => snapshotNetworth(ctx),
  "scheduled.materialize": (ctx) => materializeScheduled(ctx),
  "digest.weekly": (ctx) => runWeeklyDigest(ctx),
  "backup.check": (ctx) => runBackupCheck(ctx),
  "health.connections": (ctx) => runConnectionHealth(ctx),
};
