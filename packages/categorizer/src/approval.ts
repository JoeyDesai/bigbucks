/**
 * §9.4 approval policy. Thresholds come from Settings (defaults shown in the spec).
 *
 *  - Auto-approve: rule/history with confidence ≥ 0.95, or AI with confidence ≥ 0.95 and
 *    |amount| < $150, and the category isn't flagged "always review".
 *  - Auto-categorize but leave unapproved at confidence ≥ 0.75; below that, suggestions only.
 *  - Income over $500 and anything categorized to Ready to Assign need review the first 3 times
 *    for a given payee.
 */
import { absMilli, type CatzMethod, type Milli } from "@homebase/shared";
import type { CategoryInfo } from "./types";

export interface ApprovalSettings {
  ruleHistoryAutoApproveMin: number;
  aiAutoApproveMin: number;
  /** AI auto-approve only when |amount| is strictly below this. */
  aiAutoApproveMaxAbsMilli: Milli;
  /** Minimum confidence to set a category at all. */
  categorizeMin: number;
  alwaysReviewCategoryIds: readonly string[];
  /** Inflows above this are "income" for the first-N rule. */
  incomeReviewMinMilli: Milli;
  firstNReview: number;
}

export const DEFAULT_APPROVAL_SETTINGS: ApprovalSettings = {
  ruleHistoryAutoApproveMin: 0.95,
  aiAutoApproveMin: 0.95,
  aiAutoApproveMaxAbsMilli: 150_000n,
  categorizeMin: 0.75,
  alwaysReviewCategoryIds: [],
  incomeReviewMinMilli: 500_000n,
  firstNReview: 3,
};

/** Default "always review" set: Misc, Uncategorized, and any Savings category (§9.4). */
export function defaultAlwaysReview(catalog: readonly CategoryInfo[]): string[] {
  const plain = (s: string) => s.replace(/[^\p{L}\p{N} ]/gu, " ").trim();
  return catalog
    .filter((c) => c.kind === "uncategorized" || /\bmisc(ellaneous)?\b/i.test(plain(c.name)) || /\bsavings?\b/i.test(plain(c.name)) || /\bsavings?\b/i.test(plain(c.group)))
    .map((c) => c.id);
}

export interface ApprovalInput {
  method: CatzMethod;
  confidence: number;
  amountMilli: Milli;
  /** Category (or every split line's category). Empty for transfers without a category. */
  categoryIds: readonly string[];
  /** Explicit rule action (true/false) when a rule decided it. */
  ruleAutoApprove?: boolean;
  /** True when any category is the internal Ready to Assign category. */
  toReadyToAssign: boolean;
  /** How many earlier transactions from this payee were income>$500 / RTA and already reviewed. */
  priorReviewedForPayee: number;
}

export interface ApprovalDecision {
  /** Apply the category (otherwise only suggest). */
  categorize: boolean;
  approve: boolean;
  reasons: string[];
}

export function decideApproval(i: ApprovalInput, s: ApprovalSettings = DEFAULT_APPROVAL_SETTINGS): ApprovalDecision {
  const reasons: string[] = [];
  const deterministic = i.method === "rule" || i.method === "transfer" || i.method === "user";
  const categorize = deterministic || i.confidence >= s.categorizeMin;
  if (!categorize) return { categorize: false, approve: false, reasons: [`confidence ${i.confidence.toFixed(2)} below ${s.categorizeMin}: suggestion only`] };

  const isIncome = i.amountMilli > 0n && i.amountMilli > s.incomeReviewMinMilli;
  if ((isIncome || i.toReadyToAssign) && i.priorReviewedForPayee < s.firstNReview) {
    reasons.push(`${isIncome ? "income over the review threshold" : "Ready to Assign"}: review ${i.priorReviewedForPayee + 1} of the first ${s.firstNReview} for this payee`);
    return { categorize, approve: false, reasons };
  }

  if (i.ruleAutoApprove === true) return { categorize, approve: true, reasons: ["rule says auto-approve"] };
  if (i.ruleAutoApprove === false) return { categorize, approve: false, reasons: ["rule says review"] };

  const flagged = i.categoryIds.find((c) => s.alwaysReviewCategoryIds.includes(c));
  if (flagged) return { categorize, approve: false, reasons: ["category is flagged always review"] };

  switch (i.method) {
    case "transfer":
    case "user":
      return { categorize, approve: true, reasons: [i.method === "transfer" ? "matched transfer" : "set by user"] };
    case "rule":
    case "history":
    case "ynab":
      if (i.confidence >= s.ruleHistoryAutoApproveMin) return { categorize, approve: true, reasons: [`${i.method} confidence ${i.confidence.toFixed(2)}`] };
      return { categorize, approve: false, reasons: [`${i.method} confidence ${i.confidence.toFixed(2)} below ${s.ruleHistoryAutoApproveMin}`] };
    case "ai":
    case "ai_web":
      if (i.confidence < s.aiAutoApproveMin) return { categorize, approve: false, reasons: [`AI confidence ${i.confidence.toFixed(2)} below ${s.aiAutoApproveMin}`] };
      if (absMilli(i.amountMilli) >= s.aiAutoApproveMaxAbsMilli) return { categorize, approve: false, reasons: ["AI-categorized amount is too large to auto-approve"] };
      return { categorize, approve: true, reasons: [`AI confidence ${i.confidence.toFixed(2)}`] };
  }
}
