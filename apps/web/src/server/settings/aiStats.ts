import "server-only";
import { sql } from "drizzle-orm";
import type { Db } from "@homebase/db";

export interface UsageMonth {
  month: string;
  /** micro-USD per purpose. */
  byPurpose: Record<string, string>;
  total: string;
}

/** ai_usage by America/New_York month and purpose (cost_usd is exact numeric; summed in micro-USD). */
export async function usageByMonth(db: Db, months = 6): Promise<UsageMonth[]> {
  const res = await db.execute<{ month: string; purpose: string; micro: string }>(sql`
    SELECT to_char(date_trunc('month', at AT TIME ZONE 'America/New_York'), 'YYYY-MM-01') AS month, purpose::text,
      sum(round(cost_usd * 1000000))::bigint::text AS micro
    FROM ai_usage
    WHERE at >= (date_trunc('month', now() AT TIME ZONE 'America/New_York') - make_interval(months => ${months - 1})) AT TIME ZONE 'America/New_York'
    GROUP BY 1, 2 ORDER BY 1`);
  const out = new Map<string, UsageMonth>();
  // Every month in the window, even empty ones, so the chart has a stable x axis.
  const now = new Date();
  const ny = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).format(now);
  let [y, m] = ny.split("-").map(Number) as [number, number];
  const keys: string[] = [];
  for (let i = 0; i < months; i++) {
    keys.unshift(`${y}-${String(m).padStart(2, "0")}-01`);
    m--;
    if (m === 0) {
      m = 12;
      y--;
    }
  }
  for (const k of keys) out.set(k, { month: k, byPurpose: {}, total: "0" });
  for (const r of res.rows) {
    const e = out.get(r.month);
    if (!e) continue;
    e.byPurpose[r.purpose] = r.micro;
    e.total = (BigInt(e.total) + BigInt(r.micro)).toString();
  }
  return [...out.values()];
}

export async function usageByModelThisMonth(db: Db): Promise<{ model: string; calls: number; inputTokens: number; outputTokens: number; micro: string }[]> {
  const res = await db.execute<{ model: string; calls: number; input: string; output: string; micro: string }>(sql`
    SELECT model, count(*)::int AS calls, sum(input_tokens)::bigint::text AS input, sum(output_tokens)::bigint::text AS output, sum(round(cost_usd * 1000000))::bigint::text AS micro
    FROM ai_usage
    WHERE at >= date_trunc('month', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'
    GROUP BY model ORDER BY sum(cost_usd) DESC`);
  return res.rows.map((r) => ({ model: r.model, calls: r.calls, inputTokens: Number(r.input), outputTokens: Number(r.output), micro: r.micro }));
}

export interface AccuracyMonth {
  month: string;
  live: { accepted: number; corrected: number; pending: number };
  shadow: { accepted: number; corrected: number };
  byMethod: Record<string, { accepted: number; corrected: number }>;
}

/**
 * Categorization accuracy (§12.6): non-user suggestions by month. `accepted` true = kept, false =
 * corrected, null = not reviewed yet. Shadow events (YNAB parallel run) compare against YNAB's category.
 */
export async function accuracyByMonth(db: Db, months = 6): Promise<AccuracyMonth[]> {
  const res = await db.execute<{ month: string; shadow: boolean; method: string; accepted: number; corrected: number; pending: number }>(sql`
    SELECT to_char(date_trunc('month', at AT TIME ZONE 'America/New_York'), 'YYYY-MM-01') AS month, shadow, method::text,
      count(*) FILTER (WHERE accepted IS TRUE)::int AS accepted,
      count(*) FILTER (WHERE accepted IS FALSE)::int AS corrected,
      count(*) FILTER (WHERE accepted IS NULL)::int AS pending
    FROM categorization_events
    WHERE method <> 'user' AND at >= (date_trunc('month', now() AT TIME ZONE 'America/New_York') - make_interval(months => ${months - 1})) AT TIME ZONE 'America/New_York'
    GROUP BY 1, 2, 3 ORDER BY 1`);
  const out = new Map<string, AccuracyMonth>();
  for (const r of res.rows) {
    const e = out.get(r.month) ?? { month: r.month, live: { accepted: 0, corrected: 0, pending: 0 }, shadow: { accepted: 0, corrected: 0 }, byMethod: {} };
    if (r.shadow) {
      e.shadow.accepted += r.accepted;
      e.shadow.corrected += r.corrected;
    } else {
      e.live.accepted += r.accepted;
      e.live.corrected += r.corrected;
      e.live.pending += r.pending;
      const m = (e.byMethod[r.method] ??= { accepted: 0, corrected: 0 });
      m.accepted += r.accepted;
      m.corrected += r.corrected;
    }
    out.set(r.month, e);
  }
  return [...out.values()];
}
