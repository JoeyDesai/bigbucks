/**
 * Homebase worker (spec §8): pg-boss jobs for sync, categorization, snapshots, digests and checks.
 *
 * Run: `node --import tsx apps/worker/src/index.ts` (Docker) or `pnpm --filter @homebase/worker start`.
 * Importing this module (e.g. from apps/web for "Sync now") does not start anything.
 */
import { pathToFileURL } from "node:url";
import { env as dbEnv } from "@homebase/db";
import { createBoss, registerJobs, startHeartbeat } from "./boss";
import { JOB_NAMES } from "./jobs/definitions";
import { workerEnv } from "./env";
import { errInfo } from "./log";
import { getOrCreateVapidKeys } from "./push";
import { createRuntime } from "./runtime";
import { bootstrapConnections } from "./secrets";

export { JOBS, JOB_NAMES, JOB_TZ, MANUAL_SYNC_PROVIDERS, type JobDef, type ManualSyncProvider } from "./jobs/definitions";
export { createBoss, enqueueManualSync, registerJobs } from "./boss";

export async function main(): Promise<void> {
  const env = workerEnv();
  let boss: ReturnType<typeof createBoss> | undefined;
  const rt = createRuntime({
    enqueue: async (name, data) => {
      if (!boss) return;
      await boss.send(name, data ?? {});
    },
  });
  const { ctx } = rt;
  const log = ctx.log;
  log.info({ jobs: JOB_NAMES.length }, "homebase worker starting");

  try {
    const created = await bootstrapConnections({ db: ctx.db, log, keyring: ctx.keyring, env });
    if (created.length) log.info({ providers: created }, "bootstrap credentials moved into encrypted connections");
  } catch (e) {
    log.error({ err: errInfo(e) }, "could not store bootstrap credentials (is HOMEBASE_MASTER_KEY set?)");
  }
  try {
    await getOrCreateVapidKeys(ctx.db, env.VAPID_SUBJECT, ctx.keyring);
  } catch (e) {
    log.error({ err: errInfo(e) }, "could not initialize VAPID keys; push disabled until fixed");
  }

  boss = createBoss(dbEnv().DATABASE_URL, env.PGBOSS_SCHEMA);
  boss.on("error", (e) => log.error({ err: errInfo(e) }, "pg-boss error"));
  await boss.start();
  const names = await registerJobs(boss, ctx);
  log.info({ queues: names }, "jobs registered");
  const stopHeartbeat = startHeartbeat(boss, env.WORKER_HEARTBEAT_FILE, env.WORKER_HEARTBEAT_INTERVAL_MS, log);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down: waiting for active jobs");
    stopHeartbeat();
    try {
      await boss!.stop({ graceful: true, wait: true, timeout: 60_000 });
    } catch (e) {
      log.error({ err: errInfo(e) }, "pg-boss stop failed");
    }
    await rt.close();
    log.info("worker stopped");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error("worker failed to start:", errInfo(e).message);
    process.exit(1);
  });
}

