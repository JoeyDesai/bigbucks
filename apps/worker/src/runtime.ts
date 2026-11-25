/** Build a real WorkerContext from the environment (worker process and CLIs). */
import type pg from "pg";
import { createDb, env as dbEnv, keyringFromEnv, type Keyring } from "@homebase/db";
import { defaultRecompute } from "./budget";
import type { WorkerContext } from "./context";
import { workerEnv } from "./env";
import { defaultCategorizer, defaultTransferDetector } from "./hooks";
import { defaultDigestGenerator } from "./jobs/digest";
import { createLogger, type Logger } from "./log";
import { createPusher } from "./push";

export interface Runtime {
  ctx: WorkerContext;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export function loadKeyring(log: Logger): Keyring | undefined {
  try {
    return dbEnv().HOMEBASE_MASTER_KEY ? keyringFromEnv() : undefined;
  } catch (e) {
    log.error({ err: (e as Error).message }, "HOMEBASE_MASTER_KEY is invalid");
    throw e;
  }
}

export function createRuntime(o: { name?: string; enqueue?: WorkerContext["enqueue"]; logger?: Logger } = {}): Runtime {
  const env = workerEnv();
  const log = o.logger ?? createLogger({ level: env.LOG_LEVEL, ...(o.name ? { name: o.name } : {}) });
  const { db, pool } = createDb(dbEnv().DATABASE_URL, { max: 6 });
  const keyring = loadKeyring(log);
  const ctx: WorkerContext = {
    db,
    log,
    env,
    keyring,
    now: () => new Date(),
    enqueue:
      o.enqueue ??
      (async (name) => {
        log.debug({ job: name }, "enqueue skipped (no queue in this process)");
      }),
    recompute: defaultRecompute,
    detectTransfers: defaultTransferDetector(),
    categorizePending: defaultCategorizer("pending", env.ANTHROPIC_API_KEY),
    categorizeBatch: defaultCategorizer("batch", env.ANTHROPIC_API_KEY),
    digest: defaultDigestGenerator(db, env.ANTHROPIC_API_KEY),
    push: createPusher({ db, log, subject: env.VAPID_SUBJECT, keyring }),
  };
  return { ctx, pool, close: () => pool.end() };
}
