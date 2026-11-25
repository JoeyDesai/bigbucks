/** pg-boss wiring: queues, cron schedules, workers, retry → connection error, heartbeat. */
import { utimes, writeFile } from "node:fs/promises";
import { inArray } from "drizzle-orm";
import PgBoss from "pg-boss";
import { connections } from "@homebase/db";
import type { WorkerContext } from "./context";
import { JobError } from "./jobs/common";
import { JOBS, JOB_TZ, RETIRED_JOBS, type JobDef, type ManualSyncProvider } from "./jobs/definitions";
import { HANDLERS, type JobHandler } from "./jobs/handlers";
import { errInfo } from "./log";
import { markConnectionError } from "./ingest/syncRuns";

export function createBoss(databaseUrl: string, schema: string): PgBoss {
  return new PgBoss({ connectionString: databaseUrl, schema, application_name: "homebase-worker", max: 4 });
}

/** Run one job with logging; on the final failed attempt mark the job's connections `error` (§8.1). */
export async function runJob(ctx: WorkerContext, def: JobDef, handler: JobHandler, job: { id: string; data: unknown; retryCount?: number; retryLimit?: number }): Promise<unknown> {
  const log = ctx.log.child({ job: def.name, jobId: job.id, attempt: (job.retryCount ?? 0) + 1 });
  const started = Date.now();
  try {
    const result = await handler(ctx, job.data);
    log.info({ ms: Date.now() - started, result: summarize(result) }, "job done");
    return result;
  } catch (e) {
    const final = (job.retryCount ?? 0) >= (job.retryLimit ?? def.retryLimit);
    log.error({ ms: Date.now() - started, err: errInfo(e), final }, "job failed");
    if (final) {
      const ids = e instanceof JobError ? e.connectionIds : [];
      const target = ids.length ? ids : def.provider ? (await ctx.db.select({ id: connections.id }).from(connections).where(inArray(connections.provider, [def.provider]))).map((c) => c.id) : [];
      for (const id of target) await markConnectionError(ctx.db, id, (e as Error).message, ctx.now());
    }
    throw e;
  }
}

function summarize(r: unknown): unknown {
  const s = JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return s && s.length > 2000 ? `${s.slice(0, 2000)}…` : r === undefined ? null : JSON.parse(s);
}

export interface RegisterOptions {
  defs?: readonly JobDef[];
  handlers?: Record<string, JobHandler>;
}

/** Create/update queues, (un)schedule crons in America/New_York and start one worker per queue. */
export async function registerJobs(boss: PgBoss, ctx: WorkerContext, o: RegisterOptions = {}): Promise<string[]> {
  const defs = o.defs ?? JOBS;
  const handlers = o.handlers ?? HANDLERS;
  const names: string[] = [];
  if (!o.defs) for (const name of RETIRED_JOBS) await boss.unschedule(name).catch(() => undefined);
  for (const d of defs) {
    const handler = handlers[d.name];
    if (!handler) throw new Error(`no handler for job ${d.name}`);
    const opts = { name: d.name, policy: d.policy, retryLimit: d.retryLimit, retryDelay: d.retryDelay, retryBackoff: d.retryBackoff, expireInSeconds: d.expireInSeconds };
    if (await boss.getQueue(d.name)) await boss.updateQueue(d.name, opts);
    else await boss.createQueue(d.name, opts);
    if (d.cron) await boss.schedule(d.name, d.cron, { trigger: "scheduled" }, { tz: JOB_TZ });
    else await boss.unschedule(d.name);
    await boss.work(d.name, { batchSize: 1, includeMetadata: true }, async (jobs) => {
      for (const job of jobs) await runJob(ctx, d, handler, job);
    });
    names.push(d.name);
  }
  return names;
}

/** "Sync now" entry point (web server action or CLI): one queued job per provider. */
export async function enqueueManualSync(boss: PgBoss, provider: ManualSyncProvider, userId?: string): Promise<string | null> {
  return boss.send("sync.manual", { provider, ...(userId ? { userId } : {}) }, { singletonKey: provider });
}

/**
 * Heartbeat (infra contract): touch the file at least every 60 s while pg-boss answers a query.
 * Returns a stop function.
 */
export function startHeartbeat(boss: PgBoss, file: string, intervalMs: number, log: WorkerContext["log"]): () => void {
  let stopped = false;
  const beat = async () => {
    if (stopped) return;
    try {
      await boss.getDb().executeSql("select 1", []);
      const now = new Date();
      try {
        await utimes(file, now, now);
      } catch {
        await writeFile(file, `${now.toISOString()}\n`);
      }
    } catch (e) {
      log.warn({ err: errInfo(e) }, "heartbeat skipped: pg-boss database not reachable");
    }
  };
  void beat();
  const t = setInterval(() => void beat(), intervalMs);
  t.unref();
  return () => {
    stopped = true;
    clearInterval(t);
  };
}
