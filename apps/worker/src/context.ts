/** Everything a job needs, injected so tests can swap the clock, HTTP, push and sibling-package hooks. */
import type { HttpClientOptions } from "@homebase/connectors";
import type { Db, Keyring } from "@homebase/db";
import { toLocalDate, type ISODate } from "@homebase/shared";
import type { WorkerEnv } from "./env";
import type { CategorizeFn, RecomputeFn, TransferDetector } from "./hooks";
import type { Logger } from "./log";
import type { DigestGenerator } from "./jobs/digest";
import type { Pusher } from "./push";

export interface WorkerContext {
  db: Db;
  log: Logger;
  env: WorkerEnv;
  /** Encryption keyring; undefined = HOMEBASE_MASTER_KEY from env. */
  keyring?: Keyring | undefined;
  /** Shared HTTP options for connectors (tests inject `fetch` here; nothing live in tests). */
  http?: HttpClientOptions | undefined;
  now: () => Date;
  /** Enqueue a pg-boss job (no-op recorder in tests and CLIs). */
  enqueue: (name: string, data?: object) => Promise<void>;
  recompute: RecomputeFn;
  detectTransfers: TransferDetector;
  categorizePending: CategorizeFn;
  categorizeBatch: CategorizeFn;
  digest: DigestGenerator;
  push: Pusher;
}

export function todayOf(ctx: Pick<WorkerContext, "now">): ISODate {
  return toLocalDate(ctx.now());
}
