/**
 * Persistence boundary for the categorizer. The db layer implements CategorizerRepo against
 * @homebase/db (payees, payee_aliases, rules, transactions, categorization_events, settings,
 * household_memory); tests and the evaluation harness use InMemoryCategorizerRepo.
 */
import type { CatzMethod, ISODate, Milli } from "@homebase/shared";
import type { MerchantProfile, SimilarTxn } from "@homebase/ai";
import type { Rule } from "./rules";
import type { TransferTxn } from "./transfers";
import type { AccountInfo, CategoryInfo, HistoryTxn, PayeeAlias, PayeeRecord, TxnInput } from "./types";

/** categorization_events row (§5.2). `payeeKey` lets learning query by payee without a join. */
export interface CategorizationEventInput {
  transactionId: string;
  payeeKey: string | null;
  suggestedCategoryId: string | null;
  finalCategoryId: string | null;
  method: CatzMethod;
  confidence: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: bigint;
  /** true = approved as suggested; false = user changed it; null = not reviewed yet. */
  accepted: boolean | null;
  at: string;
  /** Parallel-run shadow mode: suggestion recorded, not applied (§10). */
  shadow?: boolean;
  /** The user who made the change (corrections/approvals). */
  userId?: string | null;
}

export interface CategorizationEvent extends CategorizationEventInput {
  id: string;
}

export interface SimilarQuery {
  transactionId: string;
  payeeKey: string;
  payeeName: string;
  rawDescription: string;
  amountMilli: Milli;
  /** Only transactions strictly before this date (no leakage in evaluation). */
  before: ISODate;
  limit: number;
}

export interface CategorizerRepo {
  /** Categories with group, note, target summary and 3–5 example payees. */
  getCategoryCatalog(): Promise<CategoryInfo[]>;
  getAccounts(): Promise<AccountInfo[]>;
  getHouseholdMemory(): Promise<string[]>;
  getAliases(): Promise<PayeeAlias[]>;
  getPayeeById(id: string): Promise<PayeeRecord | null>;
  getPayeeByKey(normalizedKey: string): Promise<PayeeRecord | null>;
  /** Finalized past transactions for a payee (newest first), optionally only before a date. */
  getPayeeHistory(payeeKey: string, opts?: { before?: ISODate; limit?: number }): Promise<HistoryTxn[]>;
  /** pg_trgm payee similarity plus same amount ±10%, with final categories (§9.3). */
  similarTransactions(q: SimilarQuery): Promise<SimilarTxn[]>;
  /** Unpaired transactions in other accounts within ±windowDays with the opposite amount. */
  getTransferCandidates(txn: TxnInput, windowDays: number): Promise<TransferTxn[]>;
  getRules(): Promise<Rule[]>;
  /**
   * Count of earlier, already-approved transactions from this payee that were income above
   * `incomeOverMilli` or categorized to Ready to Assign (§9.4 first-3 review rule).
   */
  countPriorReviewed(payeeKey: string, q: { incomeOverMilli: Milli; rtaCategoryId: string | null; before: ISODate }): Promise<number>;
  saveEvent(e: CategorizationEventInput): Promise<void>;
  /** Newest first. */
  recentEventsForPayee(payeeKey: string, limit: number): Promise<CategorizationEvent[]>;
  /** Cache a merchant profile on the payee (create the payee if needed). */
  upsertMerchantProfile(payeeKey: string, payeeName: string, profile: MerchantProfile): Promise<void>;
  recordRuleHit(ruleId: string, at: string): Promise<void>;
  createRule(rule: Omit<Rule, "id">): Promise<Rule>;
  setRuleEnabled(ruleId: string, enabled: boolean): Promise<void>;
  unapprovedTransactionIdsForPayee(payeeKey: string): Promise<string[]>;
}
