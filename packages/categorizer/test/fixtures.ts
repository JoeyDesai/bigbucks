import type { CategorizeInput, CategorizeOutcome, MerchantLookupQuery, MerchantLookupResult } from "@homebase/ai";
import type { AiCategorizer } from "../src/aiAdapter";
import type { AccountInfo, CategoryInfo } from "../src/types";

export const CATS: CategoryInfo[] = [
  { id: "c-rta", group: "Inflow", name: "Inflow: Ready to Assign", kind: "internal_rta" },
  { id: "c-unc", group: "System", name: "Uncategorized", kind: "uncategorized" },
  { id: "c-ccp-fab", group: "Credit Card Payments", name: "Fabrikam", kind: "cc_payment" },
  { id: "c-groc", group: "Everyday", name: "🛒 Groceries", kind: "normal" },
  { id: "c-gas", group: "Everyday", name: "⛽ Gas", kind: "normal" },
  { id: "c-dining", group: "Everyday", name: "Dining Out", kind: "normal" },
  { id: "c-house", group: "Home", name: "House Projects", kind: "normal" },
  { id: "c-misc", group: "Everyday", name: "🤷 Misc", kind: "normal" },
  { id: "c-emerg", group: "Savings Goals", name: "Emergency Fund", kind: "normal" },
  { id: "c-subs", group: "Monthly", name: "Subscriptions", kind: "normal" },
];

export const ACCOUNTS: AccountInfo[] = [
  { id: "a-chk", name: "Contoso Checking", nickname: "Contoso checking", institution: "Contoso Bank", kind: "checking", onBudget: true, entity: "Household", isBusiness: false },
  { id: "a-sav", name: "Contoso Savings", institution: "Contoso Bank", kind: "savings", onBudget: true, entity: "Household", isBusiness: false },
  { id: "a-card", name: "Cash Rewards", nickname: "Contoso card", institution: "Contoso Bank", kind: "credit_card", onBudget: true, entity: "Household", isBusiness: false },
  { id: "a-fab", name: "Fabrikam Cash Back", nickname: "Fabrikam card", institution: "Fabrikam", kind: "credit_card", onBudget: true, entity: "Household", isBusiness: false },
  { id: "a-merc", name: "Mercury Checking", institution: "Mercury", kind: "checking", onBudget: false, entity: "Northwind Studio LLC", isBusiness: true },
  { id: "a-401k", name: "Alex 401k", kind: "retirement", onBudget: false, entity: "Household", isBusiness: false },
];

export type StubAiCall = { input: CategorizeInput; transactionId: string };

/** Scriptable AiCategorizer stub. */
export function stubAi(opts: {
  available?: boolean | ((purpose: "categorize" | "merchant_lookup") => boolean);
  categorize?: (input: CategorizeInput) => Partial<Extract<CategorizeOutcome, { ok: true }>> | CategorizeOutcome;
  lookup?: (q: MerchantLookupQuery) => MerchantLookupResult;
}): AiCategorizer & { calls: StubAiCall[]; lookups: MerchantLookupQuery[] } {
  const calls: StubAiCall[] = [];
  const lookups: MerchantLookupQuery[] = [];
  return {
    calls,
    lookups,
    async isAvailable(purpose) {
      const a = opts.available ?? true;
      return typeof a === "function" ? a(purpose) : a;
    },
    async categorize(input, meta) {
      calls.push({ input, transactionId: meta.transactionId });
      const r = opts.categorize?.(input) ?? {};
      if ("ok" in r && r.ok === false) return r;
      return {
        ok: true,
        categoryId: null,
        confidence: 0.5,
        payeeName: input.transaction.normalizedPayee,
        isTransfer: false,
        split: null,
        needsWebLookup: false,
        explanation: "stub",
        model: "claude-haiku-5-5",
        inputTokens: 1000,
        outputTokens: 50,
        costMicroUsd: 125n,
        warnings: [],
        ...r,
      } as CategorizeOutcome;
    },
    async lookupMerchant(q) {
      lookups.push(q);
      return opts.lookup?.(q) ?? { status: "unavailable" };
    },
  };
}
