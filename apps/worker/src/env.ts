/**
 * Worker environment (Zod at the boundary). Database and master-key variables are validated by
 * `@homebase/db`'s own env; this adds the worker-only knobs and the bootstrap connector secrets.
 *
 * Bootstrap secrets are only read on first run, when they are encrypted into `connections` rows
 * (see secrets.ts). After that Settings → Connections owns them.
 */
import { z } from "zod";

const optionalString = z.string().trim().min(1).optional();

const WorkerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Infra contract: touched at least every 60 s while pg-boss is healthy (docs/decisions.md). */
  WORKER_HEARTBEAT_FILE: z.string().default("/tmp/homebase-worker.heartbeat"),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).max(60_000).default(30_000),
  /** Read-only mount of the backup sidecar's directory (`.last-success`, `.last-failure`). */
  BACKUP_DIR: z.string().default("/backups"),
  /** Push if the last successful dump is older than this. */
  BACKUP_STALE_HOURS: z.coerce.number().positive().default(26),
  /** pg-boss schema. */
  PGBOSS_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/).default("pgboss"),
  /** VAPID `sub` claim: a mailto: or https: URL identifying the sender. [VERIFY] Apple requires a real-looking one. */
  VAPID_SUBJECT: z.string().regex(/^(mailto:|https:\/\/)/).default("mailto:homebase@homebase.invalid"),
  /** YNAB plan to import (§10), by name or id. Unset: YNAB's default plan, or the only one. */
  YNAB_PLAN_NAME: optionalString,

  /** Claude (categorization, digest). Unset → rules/history only and a deterministic digest. */
  ANTHROPIC_API_KEY: optionalString,

  // Bootstrap connector credentials (moved into encrypted `connections` rows on first run).
  SIMPLEFIN_ACCESS_URL: optionalString,
  MERCURY_TOKEN: optionalString,
  YNAB_TOKEN: optionalString,
  RENTCAST_API_KEY: optionalString,
  COINBASE_KEY_NAME: optionalString,
  COINBASE_PRIVATE_KEY: optionalString,
});

export type WorkerEnv = z.output<typeof WorkerEnvSchema>;

/** Names of env vars that hold secrets; used for log redaction and never printed. */
export const SECRET_ENV_KEYS = ["SIMPLEFIN_ACCESS_URL", "MERCURY_TOKEN", "YNAB_TOKEN", "RENTCAST_API_KEY", "COINBASE_KEY_NAME", "COINBASE_PRIVATE_KEY", "HOMEBASE_MASTER_KEY", "ANTHROPIC_API_KEY"] as const;

/** Parse an env source; empty strings count as unset. Error messages name the variable, never its value. */
export function parseWorkerEnv(source: Record<string, string | undefined> = process.env): WorkerEnv {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const r = WorkerEnvSchema.safeParse(cleaned);
  if (!r.success) {
    const problems = r.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid worker environment:\n${problems}`);
  }
  return r.data;
}

let cached: WorkerEnv | undefined;
export function workerEnv(): WorkerEnv {
  cached ??= parseWorkerEnv();
  return cached;
}
