/**
 * §8.1 job table (pg-boss, cron in America/New_York). Pure data so tests and the web app can read it.
 *
 * Single instance: `stately` queues hold at most one queued + one active job, so a slow run never
 * stacks up behind the cron. `categorize.pending` is `singleton` (one active, any number queued) so
 * no sync's hint is dropped. `sync.manual` dedupes per provider with a singletonKey.
 * Retries: 3 with exponential backoff; after the last one the job's connections are marked `error`.
 */
export const JOB_TZ = "America/New_York";

export type QueuePolicy = "standard" | "short" | "singleton" | "stately";
export type JobProvider = "simplefin" | "mercury" | "coinbase" | "rentcast" | "ynab";

export interface JobDef {
  name: string;
  /** 5-field cron in America/New_York; null = enqueued on demand only. */
  cron: string | null;
  policy: QueuePolicy;
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  expireInSeconds: number;
  /** Connections of this provider are marked `error` when the final retry fails. */
  provider?: JobProvider;
  description: string;
}

const RETRY = { retryLimit: 3, retryDelay: 60, retryBackoff: true } as const;

export const JOBS: readonly JobDef[] = [
  { name: "sync.simplefin", cron: "17 5,11,17,23 * * *", policy: "stately", ...RETRY, expireInSeconds: 15 * 60, provider: "simplefin", description: "SimpleFIN Bridge, ≤ 6 requests/day incl. manual (§7.1)" },
  { name: "sync.mercury", cron: "7 7-22 * * *", policy: "stately", ...RETRY, expireInSeconds: 15 * 60, provider: "mercury", description: "Mercury, hourly at :07 07:00–22:00 (§7.2)" },
  { name: "sync.coinbase", cron: "5 23 * * *", policy: "stately", ...RETRY, expireInSeconds: 15 * 60, provider: "coinbase", description: "Coinbase balances and holdings (§7.3)" },
  { name: "sync.rentcast", cron: "0 9 2 * *", policy: "stately", ...RETRY, expireInSeconds: 10 * 60, provider: "rentcast", description: "RentCast home value, cap 5/month (§7.6)" },
  { name: "sync.manual", cron: null, policy: "standard", ...RETRY, retryLimit: 0, expireInSeconds: 15 * 60, description: "Settings → Sync now (SimpleFIN manual cap 2/day)" },
  { name: "ynab.delta", cron: "30 4 * * *", policy: "stately", ...RETRY, expireInSeconds: 30 * 60, provider: "ynab", description: "YNAB last_knowledge_of_server deltas until cutover (§10)" },
  { name: "categorize.pending", cron: null, policy: "singleton", ...RETRY, expireInSeconds: 15 * 60, description: "Real-time categorization after every sync (§9.3)" },
  { name: "categorize.batch", cron: "30 2 * * *", policy: "stately", ...RETRY, expireInSeconds: 60 * 60, description: "Nightly Batch API backlog (§9.3)" },
  { name: "price.manual", cron: "7 * * * *", policy: "stately", ...RETRY, expireInSeconds: 5 * 60, description: "Re-value hand-entered investments at public prices (Coinbase crypto, Yahoo stocks/funds)" },
  { name: "snapshot.networth", cron: "55 23 * * *", policy: "stately", ...RETRY, expireInSeconds: 10 * 60, description: "Balances for every account incl. computed mortgage/home/crypto" },
  { name: "scheduled.materialize", cron: "10 0 * * *", policy: "stately", ...RETRY, expireInSeconds: 10 * 60, description: "Enter due scheduled transactions" },
  { name: "digest.weekly", cron: "0 18 * * 0", policy: "stately", ...RETRY, expireInSeconds: 10 * 60, description: "Weekly digest push + pinned chat message (§11.6)" },
  { name: "backup.check", cron: "45 3 * * *", policy: "stately", ...RETRY, expireInSeconds: 5 * 60, description: "Backup sidecar freshness (/backups/.last-success)" },
  { name: "health.connections", cron: "0 8 * * *", policy: "stately", ...RETRY, expireInSeconds: 5 * 60, description: "Push if a connection needs attention > 24 h" },
];

export const JOB_NAMES = JOBS.map((j) => j.name);

/** Jobs that were renamed or removed: their cron schedules are dropped at startup. */
export const RETIRED_JOBS: readonly string[] = ["price.bitcoin"];

export function jobDef(name: string): JobDef {
  const d = JOBS.find((j) => j.name === name);
  if (!d) throw new Error(`unknown job ${name}`);
  return d;
}

export const MANUAL_SYNC_PROVIDERS = ["simplefin", "mercury", "coinbase", "rentcast", "ynab"] as const;
export type ManualSyncProvider = (typeof MANUAL_SYNC_PROVIDERS)[number];
