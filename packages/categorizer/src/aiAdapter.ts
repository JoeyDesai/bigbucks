/**
 * The categorizer's view of the AI: a narrow interface so the pipeline can run with no AI at all
 * (cap reached, disabled, evaluation without AI) and tests can stub it.
 */
import { categorizeWithAi, lookupMerchant, type AiClient, type CategorizeInput, type CategorizeOutcome, type MerchantLookupQuery, type MerchantLookupResult } from "@homebase/ai";

export interface AiCategorizer {
  isAvailable(purpose: "categorize" | "merchant_lookup"): Promise<boolean>;
  categorize(input: CategorizeInput, meta: { transactionId: string }): Promise<CategorizeOutcome>;
  lookupMerchant(q: MerchantLookupQuery): Promise<MerchantLookupResult>;
}

export function createAiCategorizer(ai: AiClient, opts: { householdNames?: string[] } = {}): AiCategorizer {
  return {
    isAvailable: (purpose) => ai.isAvailable(purpose),
    categorize: (input, meta) => categorizeWithAi(ai, input, meta),
    lookupMerchant: (q) => lookupMerchant(ai, q, opts.householdNames ? { householdNames: opts.householdNames } : {}),
  };
}
