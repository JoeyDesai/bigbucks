/**
 * ynab.delta (daily 04:30 during the §10 parallel run): import YNAB changes since the stored
 * `server_knowledge`. YNAB is the source of truth until cutover: its categories, splits, memos and
 * assignments win, and new YNAB rows are merged into matching synced rows (§8.4). Stops once
 * `settings.ynab_cutover_date` is reached.
 */
import { monthOf } from "@homebase/shared";
import { todayOf, type WorkerContext } from "../context";
import { addRequests, finishSyncRun, markConnectionNeedsAttention, markConnectionOk, saveRawPayload, startSyncRun, type SyncRunErrors, type SyncTrigger } from "../ingest/syncRuns";
import { loadConnections } from "../secrets";
import { SETTING_KEYS, getSetting, parallelRunState, type YnabImportSetting } from "../settings";
import { fetchPlanExport } from "../ynab/fetch";
import { importYnabPlan, type YnabImportSummary } from "../ynab/import";
import { countingHttp, JobError, secretsDeps } from "./common";

export interface YnabDeltaResult {
  skipped?: string;
  summary?: YnabImportSummary;
  serverKnowledge?: number | null;
}

export async function runYnabDelta(ctx: WorkerContext, o: { trigger: SyncTrigger }): Promise<YnabDeltaResult> {
  const today = todayOf(ctx);
  const state = await parallelRunState(ctx.db, today);
  if (!state.imported) return { skipped: "no YNAB import yet (run `pnpm import:ynab`)" };
  if (!state.active) return { skipped: `cutover reached (${state.cutover}); YNAB deltas stopped` };
  const imp = (await getSetting<YnabImportSetting>(ctx.db, SETTING_KEYS.ynabImport))!;
  const [conn] = await loadConnections(secretsDeps(ctx), "ynab");
  if (!conn) return { skipped: "no YNAB token configured" };

  const runId = await startSyncRun(ctx.db, conn.connection.id, o.trigger, ctx.now());
  const errors: SyncRunErrors = { trigger: o.trigger, issues: [], warnings: [] };
  const http = countingHttp(ctx.http, () => addRequests(ctx.db, runId, 1));
  try {
    const raw = await fetchPlanExport(conn.creds.token, imp.plan_id, { ...(imp.server_knowledge !== null ? { lastKnowledge: imp.server_knowledge } : {}), http });
    await saveRawPayload(ctx.db, runId, "ynab", raw, ctx.now());
    const summary = await importYnabPlan(ctx.db, raw, { now: ctx.now(), delta: true });
    errors.warnings = summary.warnings.slice(0, 200);
    const changed = summary.transactions.inserted + summary.transactions.updated + summary.transactions.mergedIntoSynced + summary.transactions.deleted;
    await finishSyncRun(ctx.db, runId, { status: "ok", accountsSeen: summary.accounts, txAdded: summary.transactions.inserted, txUpdated: summary.transactions.updated + summary.transactions.mergedIntoSynced, errors, finishedAt: ctx.now() });
    await markConnectionOk(ctx.db, conn.connection.id, ctx.now());
    if (summary.earliestMonth) await ctx.recompute(ctx.db, { fromMonth: summary.earliestMonth });
    else if (changed) await ctx.recompute(ctx.db, { fromMonth: monthOf(today) });
    return { summary, serverKnowledge: summary.serverKnowledge };
  } catch (e) {
    errors.error = (e as Error).message;
    await finishSyncRun(ctx.db, runId, { status: "error", errors, finishedAt: ctx.now() });
    const status = (e as { status?: number }).status;
    if (status === 401 || status === 403) {
      await markConnectionNeedsAttention(ctx.db, conn.connection, `YNAB rejected the token (HTTP ${status})`, ctx.now());
      return { skipped: errors.error };
    }
    throw new JobError(`ynab.delta failed: ${errors.error}`, [conn.connection.id], { cause: e });
  }
}
