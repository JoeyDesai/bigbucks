/**
 * §14 Phase 4 accuracy harness. Given labeled history (e.g. YNAB-categorized transactions) and a
 * held-out window, it builds rules, history and few-shot examples ONLY from transactions dated
 * before the window (no leakage), runs the full pipeline on each held-out transaction, and reports
 * top-1 accuracy, auto-approve rate and auto-approve precision against the Phase 4 targets
 * (≥85%, ≥60%, ≥98%).
 */
import { addDays, type CatzMethod, type ISODate, type Milli } from "@homebase/shared";
import type { AiCategorizer } from "./aiAdapter";
import { InMemoryCategorizerRepo, type StoredTxn } from "./memoryRepo";
import { normalizePayee, normalizedKey } from "./normalize";
import { categorizeTransaction, loadPipelineContext, type PipelineResult, type PipelineSettings } from "./pipeline";
import type { Rule } from "./rules";
import type { AccountInfo, CategoryInfo, PayeeRecord } from "./types";

export interface LabeledTxn {
  id: string;
  accountId: string;
  date: ISODate;
  amountMilli: Milli;
  rawDescription: string;
  /** Clean payee name as categorized in YNAB (optional; normalized from raw otherwise). */
  payeeName?: string | null;
  /** Ground-truth category (null for transfers / uncategorized). */
  categoryId: string | null;
  isSplit?: boolean;
  isTransfer?: boolean;
}

export interface EvaluationInput {
  transactions: readonly LabeledTxn[];
  /** First day of the held-out window; everything before it is training data. */
  windowStart: ISODate;
  /** Last day of the window (inclusive); defaults to the latest transaction date. */
  windowEnd?: ISODate;
  categories: CategoryInfo[];
  accounts: AccountInfo[];
  memory?: string[];
  /** Rules that existed before the window. Rules created later must not be passed (leakage). */
  rules?: Rule[];
  /** Payee records (e.g. cached merchant profiles); categories on them are ignored. */
  payees?: PayeeRecord[];
  ai?: AiCategorizer | null;
  settings?: Partial<PipelineSettings>;
  now?: () => Date;
}

export interface EvaluationMistake {
  transactionId: string;
  payee: string;
  expected: string | null;
  predicted: string | null;
  method: CatzMethod;
  confidence: number;
  approved: boolean;
}

export interface EvaluationReport {
  windowStart: ISODate;
  windowEnd: ISODate;
  trainingCount: number;
  heldOutCount: number;
  /** Split transactions are excluded from scoring. */
  excludedSplits: number;
  evaluated: number;
  correct: number;
  top1Accuracy: number;
  autoApproved: number;
  autoApprovedCorrect: number;
  autoApproveRate: number;
  autoApprovePrecision: number;
  byMethod: Partial<Record<CatzMethod, { count: number; correct: number; approved: number }>>;
  aiCalls: number;
  costMicroUsd: bigint;
  meetsTargets: { accuracy: boolean; autoApproveRate: boolean; precision: boolean };
  mistakes: EvaluationMistake[];
}

function isCorrect(label: LabeledTxn, r: PipelineResult): boolean {
  const predictedTransfer = Boolean(r.transfer || r.ruleTransferAccountId);
  if (label.isTransfer) return predictedTransfer;
  if (predictedTransfer) return r.categoryId !== null && r.categoryId === label.categoryId; // e.g. business draw → RTA
  return label.categoryId !== null && r.categoryId === label.categoryId;
}

function toStored(t: LabeledTxn, withLabel: boolean): StoredTxn {
  const name = t.payeeName?.trim() || normalizePayee(t.rawDescription).name;
  return {
    id: t.id,
    accountId: t.accountId,
    date: t.date,
    amountMilli: t.amountMilli,
    rawDescription: t.rawDescription,
    payeeName: name,
    payeeKey: normalizedKey(name),
    categoryId: withLabel ? t.categoryId : null,
    isSplit: withLabel ? (t.isSplit ?? false) : false,
    isTransfer: withLabel ? (t.isTransfer ?? false) : false,
    approved: withLabel,
  };
}

export async function evaluateCategorization(input: EvaluationInput): Promise<EvaluationReport> {
  const sorted = [...input.transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const windowEnd = input.windowEnd ?? sorted[sorted.length - 1]?.date ?? input.windowStart;
  const training = sorted.filter((t) => t.date < input.windowStart);
  const heldOut = sorted.filter((t) => t.date >= input.windowStart && t.date <= windowEnd);

  // Payees learned from training only: names seen before the window (no defaultCategoryId → no label leak).
  const payees: PayeeRecord[] = (input.payees ?? []).map((p) => ({ ...p, defaultCategoryId: null }));
  const repo = new InMemoryCategorizerRepo({
    categories: input.categories,
    accounts: input.accounts,
    memory: input.memory ?? [],
    payees,
    rules: (input.rules ?? []).map((r) => ({ ...r })),
    transactions: training.map((t) => toStored(t, true)),
    // Held-out bank rows (no labels) are visible to transfer detection, as they would be at sync time.
    pending: heldOut.map((t) => toStored(t, false)),
  });
  const ctx = await loadPipelineContext(repo, input.settings ?? {});
  const deps = { repo, ai: input.ai ?? null, now: input.now ?? (() => new Date(`${addDays(windowEnd, 1)}T12:00:00Z`)) };

  const report: EvaluationReport = {
    windowStart: input.windowStart,
    windowEnd,
    trainingCount: training.length,
    heldOutCount: heldOut.length,
    excludedSplits: 0,
    evaluated: 0,
    correct: 0,
    top1Accuracy: 0,
    autoApproved: 0,
    autoApprovedCorrect: 0,
    autoApproveRate: 0,
    autoApprovePrecision: 0,
    byMethod: {},
    aiCalls: 0,
    costMicroUsd: 0n,
    meetsTargets: { accuracy: false, autoApproveRate: false, precision: false },
    mistakes: [],
  };
  for (const label of heldOut) {
    if (label.isSplit) {
      report.excludedSplits++;
      continue;
    }
    const r = await categorizeTransaction({ id: label.id, accountId: label.accountId, date: label.date, amountMilli: label.amountMilli, rawDescription: label.rawDescription }, deps, ctx);
    const ok = isCorrect(label, r);
    report.evaluated++;
    report.aiCalls += r.ai.calls;
    report.costMicroUsd += r.ai.costMicroUsd;
    if (ok) report.correct++;
    if (r.approved) {
      report.autoApproved++;
      if (ok) report.autoApprovedCorrect++;
    }
    const m = (report.byMethod[r.catz.method] ??= { count: 0, correct: 0, approved: 0 });
    m.count++;
    if (ok) m.correct++;
    if (r.approved) m.approved++;
    if (!ok && report.mistakes.length < 100) {
      report.mistakes.push({
        transactionId: label.id,
        payee: r.payee.name,
        expected: label.isTransfer ? "transfer" : label.categoryId,
        predicted: r.transfer || r.ruleTransferAccountId ? "transfer" : r.categoryId,
        method: r.catz.method,
        confidence: r.catz.confidence,
        approved: r.approved,
      });
    }
  }
  const ratio = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 10_000) / 10_000);
  report.top1Accuracy = ratio(report.correct, report.evaluated);
  report.autoApproveRate = ratio(report.autoApproved, report.evaluated);
  report.autoApprovePrecision = ratio(report.autoApprovedCorrect, report.autoApproved);
  report.meetsTargets = {
    accuracy: report.top1Accuracy >= 0.85,
    autoApproveRate: report.autoApproveRate >= 0.6,
    precision: report.autoApproved > 0 && report.autoApprovePrecision >= 0.98,
  };
  return report;
}
