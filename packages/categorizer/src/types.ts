import type { AccountKind, CategoryKind, CatzMethod, ISODate, Milli } from "@homebase/shared";
import type { MerchantProfile } from "@homebase/ai";

/** A transaction as it enters categorization. */
export interface TxnInput {
  id: string;
  accountId: string;
  date: ISODate;
  /** − outflow, + inflow */
  amountMilli: Milli;
  rawDescription: string;
  memo?: string | null;
  /** Already-known payee (e.g. set by the connector or a previous run). */
  payeeId?: string | null;
}

export interface AccountInfo {
  id: string;
  name: string;
  nickname?: string | null;
  institution?: string | null;
  kind: AccountKind;
  onBudget: boolean;
  /** Entity name, e.g. "Household" or "Business". */
  entity: string;
  /** True for the business entity (e.g. Mercury accounts). */
  isBusiness: boolean;
  /** Label safe to send to the LLM, e.g. "Checking". Defaults to nickname/name (digits redacted). */
  llmLabel?: string;
}

export interface CategoryInfo {
  id: string;
  group: string;
  name: string;
  kind: CategoryKind;
  hidden?: boolean;
  note?: string | null;
  /** Human target summary, e.g. "$900/mo". */
  target?: string | null;
  examplePayees?: string[];
  /** categories.always_review (§9.4). */
  alwaysReview?: boolean;
}

export interface PayeeRecord {
  id: string;
  name: string;
  normalizedKey: string;
  defaultCategoryId?: string | null;
  transferAccountId?: string | null;
  merchant?: MerchantProfile | null;
}

export interface PayeeAlias {
  id: string;
  pattern: string;
  match: "exact" | "prefix" | "regex";
  payeeId: string;
}

/** A past, finalized transaction used for history learning. */
export interface HistoryTxn {
  id: string;
  date: ISODate;
  amountMilli: Milli;
  /** Final category; null when split/transfer/uncategorized (ignored by history learning). */
  categoryId: string | null;
  isSplit?: boolean;
  isTransfer?: boolean;
}

export interface SplitLine {
  categoryId: string;
  amountMilli: Milli;
  memo?: string | null;
}

export interface Suggestion {
  categoryId: string;
  confidence: number;
  source: CatzMethod;
}
