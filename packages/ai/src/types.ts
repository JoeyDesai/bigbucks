import { z } from "zod";
import type { AccountKind, CategoryKind, ISODate, Milli } from "@homebase/shared";

/** Stored in payees.merchant (§5.1): what a merchant is, looked up once via web search. */
export const MerchantProfileSchema = z.object({
  website: z.string().nullable(),
  type: z.string(),
  location: z.string().nullable(),
  description: z.string(),
  confidence: z.number().min(0).max(1),
  looked_up_at: z.string(),
  /** False when the lookup ran but could not identify the business (still cached: look up once). */
  found: z.boolean().default(true),
});
export type MerchantProfile = z.infer<typeof MerchantProfileSchema>;

/** One category in the catalog sent to the categorization model (§9.3). */
export interface CatalogCategory {
  id: string;
  group: string;
  name: string;
  kind?: CategoryKind;
  note?: string | null;
  /** Human summary of the target, e.g. "$600/mo refill". */
  target?: string | null;
  /** 3–5 example payees from history. */
  examplePayees?: string[];
}

/** Transaction fields the categorization model may see (§9.3 privacy: nothing else). */
export interface CategorizeTxn {
  rawDescription: string;
  normalizedPayee: string;
  amountMilli: Milli;
  /** Account label only, e.g. "Checking", "Cash back card". Never numbers. */
  accountLabel: string;
  accountKind?: AccountKind;
  date: ISODate;
  merchant?: MerchantProfile | null;
}

export interface SimilarTxn {
  payee: string;
  rawDescription?: string | null;
  amountMilli: Milli;
  date: ISODate;
  categoryId: string | null;
  categoryName?: string | null;
  isTransfer?: boolean;
}
