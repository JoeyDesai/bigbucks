/**
 * Seams to sibling packages: typed contracts with real defaults (runtime.ts). Tests inject their own.
 */
import type { AccountKind, ISODate, Milli, Month } from "@homebase/shared";
import type { Db } from "@homebase/db";
import { detectTransferPairs } from "@homebase/categorizer";
import { createCategorizeJob } from "@homebase/categorizer/db";
import { createWorkerAiClient } from "./ai";
import type { Logger } from "./log";

// ── Budget recompute (@homebase/core `recompute`) ────────────────────────────

export type RecomputeFn = (db: Db, opts: { fromMonth?: Month | null }) => Promise<unknown>;

// ── Transfer detection (@homebase/categorizer `detectTransferPairs`, §8.3) ──────────────────────

export interface TransferTxnInput {
  id: string;
  accountId: string;
  date: ISODate;
  amountMilli: Milli;
  rawDescription: string;
  payeeName?: string | null;
  paired?: boolean;
}

export interface TransferAccountInput {
  id: string;
  name: string;
  nickname?: string | null;
  institution?: string | null;
  kind: AccountKind;
  onBudget: boolean;
  entity: string;
  isBusiness: boolean;
}

export interface DetectedTransfer {
  kind: string;
  auto: boolean;
  outflowId: string;
  inflowId: string;
  outflowAccountId: string;
  inflowAccountId: string;
  confidence: number;
  householdCategoryId: string | null;
  reason: string;
}

export type TransferDetector = (
  txns: readonly TransferTxnInput[],
  accounts: ReadonlyMap<string, TransferAccountInput>,
  opts: { rtaCategoryId: string | null },
) => { auto: DetectedTransfer[]; suggestions: DetectedTransfer[] } | Promise<{ auto: DetectedTransfer[]; suggestions: DetectedTransfer[] }>;

/** Default: @homebase/categorizer's `detectTransferPairs` (§8.3). */
export function defaultTransferDetector(): TransferDetector {
  return (txns, accounts, opts) => detectTransferPairs(txns, accounts, opts);
}

// ── Categorization (§9): categorize.pending / categorize.batch ──────────────────────────────────

export interface CategorizeRequest {
  db: Db;
  log: Logger;
  /** §10 parallel run: record suggestions in categorization_events (shadow=true) but write nothing. */
  shadow: boolean;
  /** Restrict to these transactions (after a sync); otherwise every unapproved/uncategorized row. */
  transactionIds?: string[];
}

export interface CategorizeResult {
  processed: number;
  note?: string;
}

export type CategorizeFn = (req: CategorizeRequest) => Promise<CategorizeResult>;

/**
 * Default: `@homebase/categorizer/db` `createCategorizeJob(db, ai, { shadow })`. The AI client is built
 * per run (null without ANTHROPIC_API_KEY → rules + history only). `categorize.batch` uses the same
 * pipeline as a nightly backlog sweep with a larger limit.
 * TODO(categorizer): move the backlog to the Batch API (submitBacklogBatch/collectBatchResults) once
 * batch ids have a place to live between runs.
 */
export function defaultCategorizer(kind: "pending" | "batch", apiKey: string | undefined): CategorizeFn {
  return async (req) => {
    const ai = await createWorkerAiClient(req.db, apiKey);
    const run = createCategorizeJob(req.db, ai, { shadow: req.shadow });
    const r = await run({ limit: kind === "batch" ? 2000 : 500, ...(req.transactionIds?.length ? { transactionIds: req.transactionIds } : {}) });
    if (r.errors.length) req.log.warn({ errors: r.errors.slice(0, 10) }, "categorizer errors");
    return {
      processed: r.considered,
      note: `${r.mode}: ${r.categorized} categorized, ${r.approved} approved, ${r.transfers} transfers, ${r.suggestionsOnly} suggestions, ${r.skipped} skipped, ${r.errors.length} errors, ${r.aiCalls} AI calls`,
    };
  };
}
