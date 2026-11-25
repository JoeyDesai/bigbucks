/**
 * §9.3 batch path: the nightly backlog and the initial history clean-up use the Message Batches
 * API (50% off). Steps 1–3 run synchronously; only transactions that reach the AI step are
 * batched. Results arrive in any order and are keyed by custom_id (= transaction id).
 *
 * Batches carry no refusal fallback (the parameter is rejected on Batches) and no web lookup;
 * low-confidence unknown merchants are left for the next real-time pass.
 */
import { buildCategorizeParams, parseCategorizeMessage, type AiClient, type BetaBatchRequest, type BetaMessageBatch } from "@homebase/ai";
import type { CategorizerRepo } from "./repo";
import { eventFor, finalizeWithAi, prepareTransaction, type PipelineContext, type PipelineResult, type PreparedTransaction } from "./pipeline";
import type { TxnInput } from "./types";

const CUSTOM_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export function batchCustomId(transactionId: string): string {
  if (!CUSTOM_ID.test(transactionId)) throw new Error(`transaction id ${transactionId} is not a valid batch custom_id`);
  return transactionId;
}

/** Build batch requests for prepared transactions that still need the AI step. */
export function buildBatchRequests(prepared: readonly PreparedTransaction[], model: string): BetaBatchRequest[] {
  return prepared
    .filter((p) => !p.decided && p.aiInput)
    .map((p) => ({ custom_id: batchCustomId(p.txn.id), params: buildCategorizeParams(p.aiInput!, { model }) }));
}

export interface BatchSubmission {
  batchId: string | null;
  /** Transactions decided by transfer/rules/history without AI. */
  decided: PipelineResult[];
  /** Transactions sent to the batch. */
  queuedIds: string[];
}

/**
 * Run steps 1–3 for a backlog and submit the rest as one Message Batch. Decided results are
 * returned (and their events saved) immediately.
 */
export async function submitBacklogBatch(txns: readonly TxnInput[], deps: { repo: CategorizerRepo; ai: AiClient; now?: () => Date }, ctx: PipelineContext): Promise<BatchSubmission> {
  const now = deps.now ?? (() => new Date());
  const prepared: PreparedTransaction[] = [];
  for (const t of txns) prepared.push(await prepareTransaction(t, ctx, { repo: deps.repo, now }));
  const decided = prepared.filter((p) => p.decided).map((p) => p.decided!);
  for (const d of decided) await deps.repo.saveEvent(eventFor(d, now()));
  const requests = ctx.settings.aiEnabled ? buildBatchRequests(prepared, deps.ai.models.categorize) : [];
  if (requests.length === 0 || !(await deps.ai.isAvailable("batch_categorize"))) return { batchId: null, decided, queuedIds: [] };
  const batch = await deps.ai.anthropic.beta.messages.batches.create({ requests });
  return { batchId: batch.id, decided, queuedIds: requests.map((r) => r.custom_id) };
}

export async function batchStatus(ai: AiClient, batchId: string): Promise<{ ended: boolean; batch: BetaMessageBatch }> {
  const batch = await ai.anthropic.beta.messages.batches.retrieve(batchId);
  return { ended: batch.processing_status === "ended", batch };
}

export interface BatchCollection {
  results: PipelineResult[];
  /** errored / expired / canceled / unparseable requests, to retry in real time. */
  failed: { transactionId: string; reason: string }[];
}

/**
 * Process an ended batch. Transactions are re-prepared from current data (so a worker restart
 * between submit and collect is harmless), AI output is validated, usage is recorded at batch
 * prices, and events are saved.
 */
export async function collectBatchResults(
  batchId: string,
  txns: readonly TxnInput[],
  deps: { repo: CategorizerRepo; ai: AiClient; now?: () => Date },
  ctx: PipelineContext,
): Promise<BatchCollection> {
  const now = deps.now ?? (() => new Date());
  const byId = new Map(txns.map((t) => [t.id, t]));
  const out: BatchCollection = { results: [], failed: [] };
  const seen = new Set<string>();
  for await (const r of await deps.ai.anthropic.beta.messages.batches.results(batchId)) {
    const txn = byId.get(r.custom_id);
    if (!txn || seen.has(r.custom_id)) continue;
    seen.add(r.custom_id);
    if (r.result.type !== "succeeded") {
      out.failed.push({ transactionId: txn.id, reason: r.result.type });
      continue;
    }
    const msg = r.result.message;
    await deps.ai.recordUsage("batch_categorize", msg.model, msg.usage, { batch: true, transactionId: txn.id });
    const p = await prepareTransaction(txn, ctx, { repo: deps.repo, now });
    if (p.decided) {
      // Something changed since submission (e.g. a new rule): the deterministic answer wins.
      out.results.push(p.decided);
      await deps.repo.saveEvent(eventFor(p.decided, now()));
      continue;
    }
    const outcome = parseCategorizeMessage(msg, p.aiInput!, { batch: true, prices: deps.ai.prices });
    if (!outcome.ok) out.failed.push({ transactionId: txn.id, reason: outcome.reason });
    const stats = {
      calls: 1,
      merchantLookup: "none" as const,
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      costMicroUsd: outcome.ok ? outcome.costMicroUsd : 0n,
    };
    const result = await finalizeWithAi(p, ctx, { repo: deps.repo, now }, { outcome, method: "ai", stats });
    out.results.push(result);
    await deps.repo.saveEvent(eventFor(result, now()));
  }
  for (const t of txns) if (!seen.has(t.id)) out.failed.push({ transactionId: t.id, reason: "missing from batch results" });
  return out;
}
