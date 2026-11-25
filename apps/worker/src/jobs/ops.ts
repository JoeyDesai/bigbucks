/** Operational jobs: backup.check, health.connections, categorize.pending / categorize.batch. */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { connections } from "@homebase/db";
import { todayOf, type WorkerContext } from "../context";
import { metaOf } from "../ingest/syncRuns";
import { categorizerShadowMode } from "../settings";

// ── backup.check (03:45) ──────────────────────────────────────────────────────────────────────

export interface BackupCheck {
  ok: boolean;
  lastSuccessAt: string | null;
  ageHours: number | null;
  failure: string | null;
  reason?: string;
}

/**
 * Backups are done by the sidecar (ADR "Infra: contracts"): `.last-success` (mtime = last good dump)
 * and `.last-failure` (present while the last attempt failed). Stale = older than BACKUP_STALE_HOURS.
 */
export async function checkBackupFreshness(dir: string, now: Date, staleHours: number): Promise<BackupCheck> {
  let lastSuccessAt: string | null = null;
  let ageHours: number | null = null;
  let failure: string | null = null;
  try {
    const s = await stat(join(dir, ".last-success"));
    lastSuccessAt = s.mtime.toISOString();
    ageHours = Math.floor((now.getTime() - s.mtimeMs) / 3_600_000);
  } catch {
    /* missing */
  }
  try {
    failure = (await readFile(join(dir, ".last-failure"), "utf8")).trim() || "failed";
  } catch {
    /* none */
  }
  if (failure) return { ok: false, lastSuccessAt, ageHours, failure, reason: `last backup attempt failed (${failure})` };
  if (lastSuccessAt === null) return { ok: false, lastSuccessAt, ageHours, failure, reason: "no successful backup recorded" };
  if (ageHours! >= staleHours) return { ok: false, lastSuccessAt, ageHours, failure, reason: `last successful backup is ${ageHours} h old` };
  return { ok: true, lastSuccessAt, ageHours, failure };
}

export async function runBackupCheck(ctx: WorkerContext): Promise<BackupCheck & { pushed: boolean }> {
  const r = await checkBackupFreshness(ctx.env.BACKUP_DIR, ctx.now(), ctx.env.BACKUP_STALE_HOURS);
  if (r.ok) return { ...r, pushed: false };
  ctx.log.error({ backup: r }, "backup is stale or failing");
  await ctx.push.sendToAdmins("backup", { title: "Backup problem", body: `Big Bucks backup: ${r.reason}. Check the backup container.`, url: "/settings/backups", tag: "backup" });
  return { ...r, pushed: true };
}

// ── health.connections (08:00) ────────────────────────────────────────────────────────────────

export const NEEDS_ATTENTION_PUSH_AFTER_HOURS = 24;

export async function runConnectionHealth(ctx: WorkerContext): Promise<{ stale: string[]; pushed: number }> {
  const now = ctx.now();
  const rows = await ctx.db.select().from(connections).where(eq(connections.status, "needs_attention"));
  const stale: string[] = [];
  for (const c of rows) {
    const since = metaOf(c).needsAttentionSince ?? c.updatedAt.toISOString();
    if (now.getTime() - Date.parse(since) >= NEEDS_ATTENTION_PUSH_AFTER_HOURS * 3_600_000) stale.push(c.id);
  }
  let pushed = 0;
  for (const id of stale) {
    const c = rows.find((r) => r.id === id)!;
    const banners = (metaOf(c).issues ?? []).map((i) => i.banner).filter(Boolean);
    const body = banners.length ? banners.join("; ") : `${c.label}: ${c.lastError ?? "needs reconnecting"}`;
    const r = await ctx.push.sendToAdmins("connection", { title: "Reconnect a bank", body, url: "/settings/connections", tag: `conn-${c.id.slice(0, 8)}` });
    pushed += r.sent;
  }
  return { stale, pushed };
}

// ── categorize.pending / categorize.batch ─────────────────────────────────────────────────────

export async function runCategorize(ctx: WorkerContext, kind: "pending" | "batch", data: { transactionIds?: string[] } = {}): Promise<{ shadow: boolean; processed: number; note?: string }> {
  const shadow = await categorizerShadowMode(ctx.db, todayOf(ctx));
  const fn = kind === "pending" ? ctx.categorizePending : ctx.categorizeBatch;
  const r = await fn({ db: ctx.db, log: ctx.log, shadow, ...(data.transactionIds?.length ? { transactionIds: data.transactionIds } : {}) });
  if (r.note) ctx.log.info({ kind, note: r.note }, "categorizer");
  return { shadow, ...r };
}
