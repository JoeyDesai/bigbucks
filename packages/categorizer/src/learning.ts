/**
 * §9.5 learning from corrections.
 *  - Every category change writes a categorization_event.
 *  - Two consecutive corrections of the same payee to the same category create a `learned` rule,
 *    with the toast "Learned: Lowe's → House Projects" (Undo) and an offer to re-apply it to that
 *    payee's unapproved transactions.
 *  - Monthly category-health insight: a category with more than 15 transactions a month from
 *    recognizable merchants (Misc today) gets a "new categories or rules" suggestion.
 */
import { formatMonth, monthOf, type ISODate, type Month } from "@homebase/shared";
import type { CategorizerRepo } from "./repo";
import type { Rule } from "./rules";
import { normalizedKey } from "./normalize";
import type { CategoryInfo } from "./types";

export const LEARN_AFTER_CORRECTIONS = 2;
export const LEARNED_RULE_PRIORITY = 100;

export interface CorrectionInput {
  transactionId: string;
  payeeName: string;
  payeeKey?: string;
  /** What the pipeline (or previous state) had. */
  fromCategoryId: string | null;
  toCategoryId: string;
  userId: string;
}

export interface CorrectionResult {
  learnedRule: Rule | null;
  /** e.g. "Learned: Lowe's → House Projects" */
  toast: string | null;
  /** Unapproved transactions from the same payee the UI can offer to re-apply the rule to. */
  reapplyCandidateIds: string[];
  /** Learned rules for this payee that were disabled because the household changed its mind. */
  replacedRuleIds: string[];
}

function isPayeeRule(r: Rule, key: string): boolean {
  return r.conditions.length === 1 && r.conditions[0]!.field === "payee" && r.conditions[0]!.op === "equals" && normalizedKey(r.conditions[0]!.value) === key;
}

export async function recordCorrection(input: CorrectionInput, deps: { repo: CategorizerRepo; categoryName: (id: string) => string | undefined; now?: () => Date }): Promise<CorrectionResult> {
  const now = (deps.now ?? (() => new Date()))();
  const key = input.payeeKey ?? normalizedKey(input.payeeName);
  const changed = input.fromCategoryId !== input.toCategoryId;
  await deps.repo.saveEvent({
    transactionId: input.transactionId,
    payeeKey: key,
    suggestedCategoryId: input.fromCategoryId,
    finalCategoryId: input.toCategoryId,
    method: "user",
    confidence: 1,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    costMicroUsd: 0n,
    accepted: !changed,
    at: now.toISOString(),
    userId: input.userId,
  });
  const none: CorrectionResult = { learnedRule: null, toast: null, reapplyCandidateIds: [], replacedRuleIds: [] };
  if (!changed) return none;

  // Walk the household's own decisions for this payee, newest first.
  const events = (await deps.repo.recentEventsForPayee(key, 50)).filter((e) => e.method === "user");
  let corrections = 0;
  for (const e of events) {
    if (e.finalCategoryId !== input.toCategoryId) break;
    if (e.accepted === false) corrections++;
  }
  if (corrections < LEARN_AFTER_CORRECTIONS) return none;

  const rules = await deps.repo.getRules();
  const forPayee = rules.filter((r) => r.enabled && isPayeeRule(r, key));
  if (forPayee.some((r) => r.actions.setCategoryId === input.toCategoryId)) return none; // already learned
  if (forPayee.some((r) => r.source === "user")) return none; // never override a user's own rule
  const replacedRuleIds: string[] = [];
  for (const r of forPayee.filter((r) => r.source === "learned")) {
    await deps.repo.setRuleEnabled(r.id, false);
    replacedRuleIds.push(r.id);
  }
  const toName = deps.categoryName(input.toCategoryId) ?? "category";
  const learnedRule = await deps.repo.createRule({
    name: `${input.payeeName} → ${toName}`,
    priority: LEARNED_RULE_PRIORITY,
    enabled: true,
    source: "learned",
    conditions: [{ field: "payee", op: "equals", value: input.payeeName }],
    actions: { setCategoryId: input.toCategoryId },
    hitCount: 0,
    lastHitAt: null,
  });
  const reapply = (await deps.repo.unapprovedTransactionIdsForPayee(key)).filter((id) => id !== input.transactionId);
  return {
    learnedRule,
    toast: `Learned: ${input.payeeName} → ${toName}`,
    reapplyCandidateIds: reapply,
    replacedRuleIds,
  };
}

/** Undo on the toast: disable the learned rule. */
export async function undoLearnedRule(repo: CategorizerRepo, ruleId: string): Promise<void> {
  await repo.setRuleEnabled(ruleId, false);
}

// ---------------- category health ----------------

export interface HealthTxn {
  id: string;
  date: ISODate;
  payeeKey: string | null;
  payeeName: string | null;
  categoryId: string | null;
}

export interface CategoryHealthInsight {
  month: Month;
  categoryId: string;
  categoryName: string;
  count: number;
  recognizableCount: number;
  topPayees: { name: string; count: number }[];
  message: string;
}

export interface CategoryHealthOptions {
  /** More than this many recognizable-merchant transactions in a month triggers the insight (default 15). */
  threshold?: number;
  /** Payee keys with a merchant profile or otherwise known merchants. */
  knownMerchantKeys?: ReadonlySet<string>;
  /** Limit to these categories (default: all). */
  categoryIds?: readonly string[];
}

/**
 * Category-health insights for one month of transactions. A merchant is recognizable when its
 * payee key is known (merchant profile / known list) or it appears at least twice that month.
 */
export function categoryHealthInsights(txns: readonly HealthTxn[], catalog: readonly CategoryInfo[], opts: CategoryHealthOptions = {}): CategoryHealthInsight[] {
  const threshold = opts.threshold ?? 15;
  const names = new Map(catalog.map((c) => [c.id, c.name]));
  const payeeCounts = new Map<string, number>();
  for (const t of txns) if (t.payeeKey) payeeCounts.set(t.payeeKey, (payeeCounts.get(t.payeeKey) ?? 0) + 1);
  const recognizable = (k: string | null) => Boolean(k) && (opts.knownMerchantKeys?.has(k!) || (payeeCounts.get(k!) ?? 0) >= 2);

  const byMonthCat = new Map<string, HealthTxn[]>();
  for (const t of txns) {
    if (!t.categoryId) continue;
    if (opts.categoryIds && !opts.categoryIds.includes(t.categoryId)) continue;
    const k = `${monthOf(t.date)}|${t.categoryId}`;
    const arr = byMonthCat.get(k) ?? [];
    arr.push(t);
    byMonthCat.set(k, arr);
  }
  const out: CategoryHealthInsight[] = [];
  for (const [k, list] of byMonthCat) {
    const [month, categoryId] = k.split("|") as [Month, string];
    const rec = list.filter((t) => recognizable(t.payeeKey));
    if (rec.length <= threshold) continue;
    const per = new Map<string, { name: string; count: number }>();
    for (const t of rec) {
      const e = per.get(t.payeeKey!) ?? { name: t.payeeName ?? t.payeeKey!, count: 0 };
      e.count++;
      per.set(t.payeeKey!, e);
    }
    const topPayees = [...per.values()].sort((a, b) => b.count - a.count).slice(0, 3);
    const categoryName = names.get(categoryId) ?? "Unknown";
    out.push({
      month,
      categoryId,
      categoryName,
      count: list.length,
      recognizableCount: rec.length,
      topPayees,
      message: `${categoryName} got ${rec.length} transactions in ${formatMonth(month)} from recognizable merchants (${topPayees.map((p) => `${p.name} ${p.count}`).join(", ")}). Consider new categories or rules for them.`,
    });
  }
  return out.sort((a, b) => b.recognizableCount - a.recognizableCount);
}
