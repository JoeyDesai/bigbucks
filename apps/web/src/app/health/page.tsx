import Link from "next/link";
import { getCurrentUser } from "@/server/auth";
import { loadHealth } from "@/server/queries/health";
import { timeAgo } from "@/lib/format";
import { cx } from "@/lib/cx";

export const dynamic = "force-dynamic";
export const metadata = { title: "Health" };

const started = new Date();

function Row({ k, v, tone }: { k: string; v: React.ReactNode; tone?: "pos" | "warn" | "neg" }) {
  return (
    <div className="flex justify-between gap-6 border-b border-rule py-2.5">
      <dt className="text-ink-2">{k}</dt>
      <dd className={cx("num text-right", tone === "pos" && "font-medium text-pos", tone === "warn" && "text-warn", tone === "neg" && "text-neg")}>{v}</dd>
    </div>
  );
}

/**
 * Liveness for anyone on the tailnet; details (DB, last sync per connection, job heartbeat, AI spend —
 * spec §15) only for signed-in users.
 */
export default async function HealthPage() {
  const cu = await getCurrentUser();
  const h = cu ? await loadHealth() : null;
  const heartbeatAge = h?.jobs?.heartbeatAgeMs ?? null;
  return (
    <main className="mx-auto max-w-[620px] px-6 pb-12 pt-[calc(40px+var(--safe-top))]">
      <div className="flex items-baseline justify-between">
        <h1 className="display text-[32px]">Health</h1>
        {cu && (
          <Link href="/budget" className="text-[13px] text-accent">
            Back to Plan
          </Link>
        )}
      </div>
      <dl className="mt-6 border-t border-rule text-[14px]">
        <Row k="Web" v="OK" tone="pos" />
        <Row k="Started" v={timeAgo(started.toISOString())} />
        <Row k="Node" v={process.version} />
      </dl>
      {h && (
        <>
          <h2 className="eyebrow mb-1 mt-8">Database</h2>
          <dl className="border-t border-rule text-[14px]">
            <Row k="Postgres" v={h.db.ok ? `OK · ${h.db.ms} ms` : (h.db.error ?? "down")} tone={h.db.ok ? "pos" : "neg"} />
          </dl>
          <h2 className="eyebrow mb-1 mt-8">Jobs</h2>
          <dl className="border-t border-rule text-[14px]">
            {h.jobs ? (
              <>
                <Row k="Scheduler heartbeat" v={h.jobs.cronOn ? timeAgo(h.jobs.cronOn) : "never"} tone={heartbeatAge !== null && heartbeatAge < 5 * 60_000 ? "pos" : "warn"} />
                <Row k="Last finished job" v={h.jobs.lastCompletedAt ? `${h.jobs.lastCompletedName} · ${timeAgo(h.jobs.lastCompletedAt)}` : "none yet"} />
                <Row k="Failed in 24 h" v={h.jobs.failedLast24h} tone={h.jobs.failedLast24h ? "neg" : undefined} />
              </>
            ) : (
              <Row k="Worker" v="not started against this database" tone="warn" />
            )}
          </dl>
          <h2 className="eyebrow mb-1 mt-8">Connections</h2>
          <dl className="border-t border-rule text-[14px]">
            {h.connections.length === 0 && <Row k="None yet" v="Add them in Settings → Connections" />}
            {h.connections.map((c) => (
              <Row
                key={`${c.provider}:${c.label}`}
                k={`${c.label} (${c.provider})`}
                v={`${c.status.replace("_", " ")} · ${c.lastSuccessAt ? `synced ${timeAgo(c.lastSuccessAt)}` : "never synced"}`}
                tone={c.status === "ok" ? "pos" : c.status === "error" ? "neg" : c.status === "needs_attention" ? "warn" : undefined}
              />
            ))}
          </dl>
          {h.ai && (
            <>
              <h2 className="eyebrow mb-1 mt-8">AI spend this month</h2>
              <dl className="border-t border-rule text-[14px]">
                <Row k="Spent / cap" v={`$${h.ai.spentUsd.toFixed(2)} of $${h.ai.capUsd.toFixed(2)}`} tone={h.ai.spentUsd >= h.ai.capUsd ? "neg" : h.ai.spentUsd >= h.ai.capUsd * 0.8 ? "warn" : undefined} />
              </dl>
            </>
          )}
        </>
      )}
    </main>
  );
}
