/**
 * sync.simplefin (§7.1, §8.1): 05:17/11:17/17:17/23:17 plus manual "Sync now".
 *
 * Budget: ≤ 6 requests/day per access URL including manual, manual ≤ 2/day, counted from
 * `sync_runs.requests_used` (local day). Each request = one date window (≤ 45 days, ADR).
 * Normal runs fetch the last 14 days (overlap catches late posts/edits) with pending=1.
 * Initial backfill reaches 30 days before sync start; windows that don't fit today's budget are
 * left for later runs (progress in `connections.meta.backfill`).
 */
import { eq } from "drizzle-orm";
import { accounts, type Connection } from "@homebase/db";
import {
  ConnectorError,
  SIMPLEFIN_NORMAL_LOOKBACK_DAYS,
  checkSimplefinBudget,
  dateWindows,
  fetchAccountSet,
  mapAccountSet,
  type EpochWindow,
  type ExternalAccount,
  type ExternalHolding,
  type ExternalTxn,
  type SimplefinIssue,
} from "@homebase/connectors";
import { addDays, type AccountKind, type ISODate } from "@homebase/shared";
import { todayOf, type WorkerContext } from "../../context";
import { afterIngest, HOUSEHOLD_ENTITY, ingestBatch } from "../../ingest";
import {
  addRequests,
  finishSyncRun,
  issuesToJson,
  markConnectionNeedsAttention,
  markConnectionOk,
  metaOf,
  patchConnectionMeta,
  purgeRawPayloads,
  requestsToday,
  saveRawPayload,
  startSyncRun,
  type SyncRunErrors,
  type SyncTrigger,
} from "../../ingest/syncRuns";
import { loadConnections, type CredsFor } from "../../secrets";
import { SETTING_KEYS, getSetting, setSetting } from "../../settings";
import { forEachConnection, secretsDeps, type SyncSummary } from "../common";

export const SIMPLEFIN_BACKFILL_DAYS_BEFORE_START = 30;

/** §10 sync start: first day SimpleFIN/Mercury sync ran. Set once. */
export async function ensureSyncStart(ctx: WorkerContext): Promise<ISODate> {
  const s = await getSetting<string>(ctx.db, SETTING_KEYS.syncStartDate);
  if (s) return s;
  const t = todayOf(ctx);
  await setSetting(ctx.db, SETTING_KEYS.syncStartDate, t);
  return t;
}

export interface WindowPlan {
  /** Newest first: the normal 14-day window, then backfill windows from newest to oldest. */
  windows: Array<EpochWindow & { backfill: boolean }>;
  normal: { since: ISODate; until: ISODate };
  backfillTarget: ISODate;
  backfillDone: boolean;
}

/** Pure planning of request windows for one run (newest first, so a tight budget keeps the recent data). */
export function planSimplefinWindows(today: ISODate, syncStart: ISODate, backfill: { target: string; coveredFrom: string | null; done: boolean } | undefined): WindowPlan {
  const normalSince = addDays(today, -SIMPLEFIN_NORMAL_LOOKBACK_DAYS);
  const normal = { since: normalSince, until: today };
  const target = backfill?.target ?? addDays(syncStart, -SIMPLEFIN_BACKFILL_DAYS_BEFORE_START);
  const normalWindows = dateWindows(normalSince, today).map((w) => ({ ...w, backfill: false }));
  if (backfill?.done) return { windows: normalWindows, normal, backfillTarget: target, backfillDone: true };
  const coveredFrom = backfill?.coveredFrom ?? null;
  const end = addDays(coveredFrom !== null && coveredFrom < normalSince ? coveredFrom : normalSince, -1);
  if (target > end) return { windows: normalWindows, normal, backfillTarget: target, backfillDone: true };
  if (coveredFrom === null) {
    // First run: if one window spans backfill + the normal range, that's a single request.
    const combined = dateWindows(target, today);
    if (combined.length === 1) return { windows: [{ ...combined[0]!, backfill: true }], normal, backfillTarget: target, backfillDone: false };
  }
  const older = dateWindows(target, end)
    .reverse()
    .map((w) => ({ ...w, backfill: true }));
  return { windows: [...normalWindows, ...older], normal, backfillTarget: target, backfillDone: false };
}

/** Largest prefix of the plan that fits today's budget. */
export function fitToBudget<T>(windows: T[], usage: { usedToday: number; manualToday: number }, kind: "scheduled" | "manual"): { take: T[]; reason?: string } {
  for (let k = windows.length; k >= 1; k--) {
    if (checkSimplefinBudget(usage, kind, k).allowed) return { take: windows.slice(0, k) };
  }
  return { take: [], reason: checkSimplefinBudget(usage, kind, 1).reason ?? "SimpleFIN request budget exhausted" };
}

export async function syncSimplefin(ctx: WorkerContext, o: { trigger: SyncTrigger }): Promise<SyncSummary[]> {
  const conns = await loadConnections(secretsDeps(ctx), "simplefin");
  return forEachConnection(ctx, "simplefin", conns, ({ connection, creds }) => syncSimplefinConnection(ctx, connection, creds, o.trigger));
}

export async function syncSimplefinConnection(ctx: WorkerContext, connection: Connection, creds: CredsFor<"simplefin">, trigger: SyncTrigger): Promise<SyncSummary> {
  const now = ctx.now();
  const today = todayOf(ctx);
  const syncStart = await ensureSyncStart(ctx);
  const meta = metaOf(connection);
  const plan = planSimplefinWindows(today, syncStart, meta.backfill);
  const usage = await requestsToday(ctx.db, connection.id, now);
  const budgetKind = trigger === "manual" ? "manual" : "scheduled";
  const { take, reason } = fitToBudget(plan.windows, usage, budgetKind);
  const summary: SyncSummary = { connectionId: connection.id, provider: "simplefin", status: "ok", requestsUsed: 0 };
  if (!take.length) {
    ctx.log.warn({ connectionId: connection.id, usage, trigger }, `SimpleFIN sync skipped: ${reason}`);
    return { ...summary, status: "skipped", reason: reason ?? "budget" };
  }

  const runId = await startSyncRun(ctx.db, connection.id, trigger, now);
  const errors: SyncRunErrors = { trigger, issues: [], warnings: [] };
  const known = await ctx.db.select({ externalId: accounts.externalId, kind: accounts.kind }).from(accounts).where(eq(accounts.connectionId, connection.id));
  const kinds: Record<string, AccountKind> = {};
  for (const k of known) if (k.externalId) kinds[k.externalId] = k.kind;

  let latestAccounts: ExternalAccount[] = [];
  let latestHoldings: ExternalHolding[] = [];
  const txns = new Map<string, ExternalTxn>();
  const issues: SimplefinIssue[] = [];
  const fetched: typeof take = [];
  try {
    for (const w of take) {
      await addRequests(ctx.db, runId, 1);
      summary.requestsUsed++;
      // retries: 0 — every HTTP attempt costs quota; pg-boss retries the job instead.
      const set = await fetchAccountSet(creds.accessUrl, { startDate: w.start, endDate: w.end, pending: true }, { ...(ctx.http ?? {}), retries: 0 });
      await saveRawPayload(ctx.db, runId, "simplefin", { window: { from: w.from, to: w.to }, ...set }, ctx.now());
      const m = mapAccountSet(set, { kinds });
      if (!latestAccounts.length) {
        latestAccounts = m.accounts;
        latestHoldings = m.holdings;
      }
      for (const t of m.transactions) txns.set(`${t.accountExternalId}|${t.externalId}`, t);
      issues.push(...m.issues);
      errors.warnings.push(...m.warnings);
      fetched.push(w);
    }
  } catch (e) {
    const msg = (e as Error).message;
    errors.error = msg;
    if (e instanceof ConnectorError && (e.code === "revoked" || e.code === "subscription_lapsed" || e.code === "auth")) {
      await finishSyncRun(ctx.db, runId, { status: "error", errors, finishedAt: ctx.now() });
      await markConnectionNeedsAttention(ctx.db, connection, msg, ctx.now());
      return { ...summary, status: "needs_attention", reason: msg };
    }
    await finishSyncRun(ctx.db, runId, { status: "error", errors, finishedAt: ctx.now() });
    throw e;
  }

  errors.issues = issuesToJson(dedupeIssues(issues));
  const attention = issues.filter((i) => i.status === "needs_attention");
  const troubledConn = new Set(issues.filter((i) => i.status !== "info" && i.connId).map((i) => i.connId!));
  const failedAccounts = new Set<string>(issues.filter((i) => i.status !== "info" && i.accountId).map((i) => i.accountId!));
  for (const a of latestAccounts) if (a.connectionId && troubledConn.has(a.connectionId)) failedAccounts.add(a.externalId);

  const result = await ingestBatch(ctx, {
    connection,
    source: "simplefin",
    entity: HOUSEHOLD_ENTITY,
    accounts: latestAccounts,
    transactions: [...txns.values()],
    holdings: latestHoldings,
    window: plan.normal,
    failedAccountExternalIds: failedAccounts,
  });

  // Backfill progress.
  const backfillFetched = fetched.filter((w) => w.backfill);
  const allBackfill = plan.windows.filter((w) => w.backfill);
  if (!plan.backfillDone) {
    const done = backfillFetched.length === allBackfill.length;
    const coveredFrom = backfillFetched.length ? backfillFetched.map((w) => w.from).reduce((a, b) => (a < b ? a : b)) : (meta.backfill?.coveredFrom ?? null);
    await patchConnectionMeta(ctx.db, connection.id, { backfill: { target: plan.backfillTarget, coveredFrom, done } });
  } else if (!meta.backfill?.done) {
    await patchConnectionMeta(ctx.db, connection.id, { backfill: { target: plan.backfillTarget, coveredFrom: meta.backfill?.coveredFrom ?? null, done: true } });
  }

  const status = attention.length ? "partial" : "ok";
  await finishSyncRun(ctx.db, runId, { status, accountsSeen: result.accountsSeen, txAdded: result.added, txUpdated: result.updated, errors, finishedAt: ctx.now() });
  if (attention.length) await markConnectionNeedsAttention(ctx.db, connection, attention.map((a) => a.banner ?? a.msg).join("; "), ctx.now(), errors.issues);
  else await markConnectionOk(ctx.db, connection.id, ctx.now(), errors.issues);
  await purgeRawPayloads(ctx.db, ctx.now());
  await afterIngest(ctx, { touchedIds: result.touchedIds, earliestTouched: result.earliestTouched });
  return {
    ...summary,
    status: attention.length ? "needs_attention" : status,
    accountsSeen: result.accountsSeen,
    txAdded: result.added,
    txUpdated: result.updated,
    newInboxAccounts: result.inboxAccounts.length,
  };
}

function dedupeIssues(issues: SimplefinIssue[]): SimplefinIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.code}|${i.connId ?? ""}|${i.accountId ?? ""}|${i.msg}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
