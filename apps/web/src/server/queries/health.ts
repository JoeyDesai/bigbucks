import "server-only";
import { sql } from "drizzle-orm";
import { getSetting } from "@homebase/core";
import { getDb } from "../db";

export interface HealthDetail {
  db: { ok: boolean; ms: number | null; error: string | null };
  connections: { provider: string; label: string; status: string; lastSuccessAt: string | null; lastError: string | null }[];
  jobs: { cronOn: string | null; heartbeatAgeMs: number | null; lastCompletedAt: string | null; lastCompletedName: string | null; failedLast24h: number } | null;
  ai: { spentUsd: number; capUsd: number } | null;
}

/** Signed-in /health detail (spec §15): DB, last sync per connection, job heartbeat, AI spend MTD. */
export async function loadHealth(): Promise<HealthDetail> {
  const db = getDb();
  const t0 = performance.now();
  try {
    await db.execute(sql`SELECT 1`);
  } catch (e) {
    return { db: { ok: false, ms: null, error: e instanceof Error ? e.message : String(e) }, connections: [], jobs: null, ai: null };
  }
  const ms = Math.round(performance.now() - t0);
  const conns = await db.execute<{ provider: string; label: string; status: string; last_success_at: Date | null; last_error: string | null }>(
    sql`SELECT provider, label, status, last_success_at, last_error FROM connections ORDER BY provider, label`,
  );
  let jobs: HealthDetail["jobs"] = null;
  try {
    const v = await db.execute<{ cron_on: Date | null }>(sql`SELECT cron_on FROM pgboss.version LIMIT 1`);
    const last = await db.execute<{ name: string; completed_on: Date }>(sql`SELECT name, completed_on FROM pgboss.job WHERE state = 'completed' ORDER BY completed_on DESC LIMIT 1`);
    const failed = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pgboss.job WHERE state = 'failed' AND completed_on > now() - interval '24 hours'`);
    jobs = {
      cronOn: v.rows[0]?.cron_on ? new Date(v.rows[0].cron_on).toISOString() : null,
      heartbeatAgeMs: v.rows[0]?.cron_on ? Date.now() - new Date(v.rows[0].cron_on).getTime() : null,
      lastCompletedAt: last.rows[0] ? new Date(last.rows[0].completed_on).toISOString() : null,
      lastCompletedName: last.rows[0]?.name ?? null,
      failedLast24h: failed.rows[0]?.n ?? 0,
    };
  } catch {
    jobs = null; // pg-boss schema missing: the worker has never started against this database
  }
  const spent = await db.execute<{ usd: string }>(sql`
    SELECT coalesce(sum(cost_usd), 0)::text AS usd FROM ai_usage
    WHERE at >= (date_trunc('month', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')`);
  const budget = await getSetting(db, "ai_budget");
  return {
    db: { ok: true, ms, error: null },
    connections: conns.rows.map((c) => ({ provider: c.provider, label: c.label, status: c.status, lastSuccessAt: c.last_success_at ? new Date(c.last_success_at).toISOString() : null, lastError: c.last_error })),
    jobs,
    ai: { spentUsd: Number(spent.rows[0]?.usd ?? 0), capUsd: budget.monthly_cap_usd },
  };
}
