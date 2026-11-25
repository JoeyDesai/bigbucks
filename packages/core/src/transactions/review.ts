/** Review inbox (spec §12.2): unapproved transactions with their categorization suggestions. */
import { inArray, sql } from "drizzle-orm";
import { categories } from "@homebase/db";
import type { Catz } from "@homebase/shared";
import type { Ctx, DbLike } from "../context";
import { getSetting } from "../settings";
import { listTransactions, type TransactionRow } from "./list";
import { approveTransactions } from "./mutate";

export interface Suggestion {
  categoryId: string;
  categoryName: string | null;
  confidence: number;
}

export interface InboxItem extends TransactionRow {
  method: Catz["method"] | null;
  confidence: number | null;
  explanation: string | null;
  /** Top-3 suggestions (best first); the current category when it was auto-set and there is no list. */
  suggestions: Suggestion[];
}

export interface ReviewInbox {
  count: number;
  items: InboxItem[];
  nextCursor: string | null;
}

/** Unapproved transactions, newest first, with suggestions. */
export async function reviewInbox(db: DbLike, opts: { limit?: number; cursor?: string | null; accountId?: string } = {}): Promise<ReviewInbox> {
  // investment accounts never need a review: their transactions only move the Investments totals
  const page = await listTransactions(db, { approved: false, accountIds: opts.accountId ? [opts.accountId] : undefined, excludeInvestments: opts.accountId ? undefined : true }, { limit: opts.limit ?? 50, cursor: opts.cursor });
  const ids = new Set<string>();
  for (const r of page.rows) for (const s of r.catz?.suggestions ?? []) ids.add(s.category_id);
  const names = ids.size ? new Map((await db.select({ id: categories.id, name: categories.name }).from(categories).where(inArray(categories.id, [...ids]))).map((c) => [c.id, c.name])) : new Map<string, string>();
  const items = page.rows.map((r): InboxItem => {
    const catz = r.catz;
    let suggestions: Suggestion[] = (catz?.suggestions ?? [])
      .slice()
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3)
      .map((s) => ({ categoryId: s.category_id, categoryName: names.get(s.category_id) ?? null, confidence: s.confidence }));
    if (!suggestions.length && r.categoryId && catz && catz.method !== "user") suggestions = [{ categoryId: r.categoryId, categoryName: r.categoryName, confidence: catz.confidence }];
    return { ...r, method: catz?.method ?? null, confidence: catz?.confidence ?? null, explanation: catz?.explanation ?? null, suggestions };
  });
  return { count: page.totals?.count ?? items.length, items, nextCursor: page.nextCursor };
}

/**
 * "Approve all high-confidence" (§12.2): unapproved transactions whose categorization confidence is at
 * least `threshold` (default: the AI auto-approve threshold from Settings), whose category (or every
 * split line's) isn't "always review" / Uncategorized; transfers count as categorized.
 */
export async function approveAllHighConfidence(ctx: Ctx, opts: { threshold?: number } = {}): Promise<{ approved: string[] }> {
  const policy = await getSetting(ctx.db, "approval_policy");
  const threshold = opts.threshold ?? policy.auto_approve_ai_min_confidence;
  const res = await ctx.db.execute<{ id: string }>(sql`
    SELECT t.id FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id
    WHERE NOT t.approved AND t.deleted_at IS NULL
      AND (t.catz ->> 'confidence')::real >= ${threshold}
      AND (
        (NOT t.is_split AND t.transfer_account_id IS NULL AND c.id IS NOT NULL AND NOT c.always_review AND c.kind <> 'uncategorized')
        OR (NOT t.is_split AND t.transfer_account_id IS NOT NULL AND (c.id IS NULL OR NOT c.always_review))
        OR (t.is_split AND NOT EXISTS (
          SELECT 1 FROM transaction_splits s LEFT JOIN categories sc ON sc.id = s.category_id
          WHERE s.transaction_id = t.id AND (sc.id IS NULL OR sc.always_review OR sc.kind = 'uncategorized')))
      )`);
  return approveTransactions(ctx, res.rows.map((r) => r.id));
}
