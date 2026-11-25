import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "../db";

export const SIMPLEFIN_MANUAL_CAP = 2;
export const SIMPLEFIN_DAILY_CAP = 6;

export interface SyncStatus {
  /** A SimpleFIN connection exists and isn't disabled. */
  available: boolean;
  manualUsed: number;
  totalUsed: number;
  /** A manual sync is queued or running. */
  queued: boolean;
  lastSuccessAt: string | null;
  reason: string | null;
}

/**
 * SimpleFIN request budget for "Sync now" (worker ADR "sync bookkeeping"): sum(requests_used) since
 * local midnight per connection, manual ≤ 2/day and total ≤ 6/day.
 */
export async function loadSyncStatus(): Promise<SyncStatus> {
  const db = getDb();
  const conns = await db.execute<{ id: string; status: string; last_success_at: string | Date | null }>(sql`SELECT id, status, last_success_at FROM connections WHERE provider = 'simplefin' AND status <> 'disabled'`);
  if (!conns.rows.length) return { available: false, manualUsed: 0, totalUsed: 0, queued: false, lastSuccessAt: null, reason: "No bank connection yet. Add SimpleFIN in Settings → Connections." };
  const ids = conns.rows.map((c) => c.id);
  const used = await db.execute<{ manual: number; total: number }>(sql`
    SELECT coalesce(sum(requests_used) FILTER (WHERE errors->>'trigger' = 'manual'), 0)::int AS manual,
           coalesce(sum(requests_used), 0)::int AS total
    FROM sync_runs
    WHERE connection_id IN ${ids}
      AND started_at >= (date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')`);
  let queued = false;
  try {
    const q = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'sync.manual' AND state IN ('created', 'retry', 'active')`);
    queued = (q.rows[0]?.n ?? 0) > 0;
  } catch {
    queued = false; // pg-boss schema not created yet (worker never ran)
  }
  const manualUsed = used.rows[0]?.manual ?? 0;
  const totalUsed = used.rows[0]?.total ?? 0;
  // raw SQL returns timestamptz as strings: normalize before comparing
  const last = conns.rows
    .map((c) => (c.last_success_at ? new Date(c.last_success_at) : null))
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const reason =
    manualUsed >= SIMPLEFIN_MANUAL_CAP
      ? "Manual syncs are used up for today (2 a day). The scheduled sync runs at 5, 11, 17 and 23 o'clock."
      : totalUsed >= SIMPLEFIN_DAILY_CAP
        ? "Today's SimpleFIN request budget is used up."
        : queued
          ? "A sync is already running."
          : null;
  return { available: true, manualUsed, totalUsed, queued, lastSuccessAt: last ? last.toISOString() : null, reason };
}
