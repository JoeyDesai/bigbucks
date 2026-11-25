/** Helpers shared by the transaction services. */
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { accounts, categories, categorizationEvents, payees, transactions, type Account, type Transaction } from "@homebase/db";
import { monthOf, type Catz, type Month } from "@homebase/shared";
import type { Ctx, DbLike } from "../context";
import { NotFoundError, ValidationError } from "../errors";

/** Same normalization as the demo seed / payees.normalized_key. */
export function payeeKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function getAccountOrThrow(db: DbLike, id: string): Promise<Account> {
  const [a] = await db.select().from(accounts).where(eq(accounts.id, id));
  if (!a || a.deletedAt) throw new NotFoundError("account", id);
  return a;
}

export async function getTxOrThrow(db: DbLike, id: string, opts: { forUpdate?: boolean } = {}): Promise<Transaction> {
  const q = db.select().from(transactions).where(eq(transactions.id, id));
  const [t] = opts.forUpdate ? await q.for("update") : await q;
  if (!t || t.deletedAt) throw new NotFoundError("transaction", id);
  return t;
}

/** A category that transactions may use (any non-deleted category except none). */
export async function checkCategory(db: DbLike, categoryId: string | null): Promise<void> {
  if (categoryId === null) return;
  const [c] = await db.select({ id: categories.id, deletedAt: categories.deletedAt }).from(categories).where(eq(categories.id, categoryId));
  if (!c) throw new NotFoundError("category", categoryId);
  if (c.deletedAt) throw new ValidationError("category is deleted");
}

/** Find or create a payee by name (normalized key). */
export async function resolvePayee(db: DbLike, p: { payeeId?: string | null; payeeName?: string | null }): Promise<string | null> {
  if (p.payeeId) {
    const [row] = await db.select({ id: payees.id }).from(payees).where(eq(payees.id, p.payeeId));
    if (!row) throw new NotFoundError("payee", p.payeeId);
    return row.id;
  }
  const name = p.payeeName?.trim();
  if (!name) return null;
  const key = payeeKey(name);
  if (!key) throw new ValidationError("payee name is empty");
  const [existing] = await db.select({ id: payees.id, deletedAt: payees.deletedAt }).from(payees).where(eq(payees.normalizedKey, key));
  if (existing) {
    if (existing.deletedAt) await db.update(payees).set({ deletedAt: null }).where(eq(payees.id, existing.id));
    return existing.id;
  }
  const [row] = await db.insert(payees).values({ name, normalizedKey: key }).returning({ id: payees.id });
  return row!.id;
}

/** The "Transfer : <account>" payee for an account (created on demand). */
export async function transferPayeeFor(db: DbLike, account: Account): Promise<string> {
  const [p] = await db.select({ id: payees.id }).from(payees).where(and(eq(payees.transferAccountId, account.id), isNull(payees.deletedAt)));
  if (p) return p.id;
  const key = `transfer ${payeeKey(account.name)}`;
  const [byKey] = await db.select({ id: payees.id }).from(payees).where(eq(payees.normalizedKey, key));
  if (byKey) return byKey.id;
  const [row] = await db.insert(payees).values({ name: `Transfer : ${account.name}`, normalizedKey: key, transferAccountId: account.id }).returning({ id: payees.id });
  return row!.id;
}

/**
 * §9.5: every category change writes a categorization_event (method user). `accepted` says whether the
 * user's choice matches what was suggested before (null when there was no suggestion). Pending events for
 * the transaction (accepted null) are closed with the final category.
 */
export async function logCategoryChange(db: DbLike, ctx: Ctx, t: Pick<Transaction, "id" | "categoryId" | "catz">, finalCategoryId: string | null): Promise<void> {
  const catz = t.catz as Catz | null;
  const suggested = catz?.suggestions?.[0]?.category_id ?? (catz && catz.method !== "user" ? t.categoryId : null) ?? null;
  await db
    .update(categorizationEvents)
    .set({ finalCategoryId, accepted: sql`${categorizationEvents.suggestedCategoryId} IS NOT DISTINCT FROM ${finalCategoryId}::uuid` })
    .where(and(eq(categorizationEvents.transactionId, t.id), isNull(categorizationEvents.accepted), eq(categorizationEvents.shadow, false), ne(categorizationEvents.method, "user")));
  await db.insert(categorizationEvents).values({
    transactionId: t.id,
    suggestedCategoryId: suggested,
    finalCategoryId,
    method: "user",
    confidence: 1,
    accepted: suggested === null ? null : suggested === finalCategoryId,
    userId: ctx.userId,
  });
}

export const userCatz = (): Catz => ({ method: "user", confidence: 1, at: new Date().toISOString() });

export function minMonth(...dates: (string | null | undefined)[]): Month | null {
  let m: Month | null = null;
  for (const d of dates) {
    if (!d) continue;
    const mm = monthOf(d);
    if (m === null || mm < m) m = mm;
  }
  return m;
}

export async function accountsById(db: DbLike, ids: string[]): Promise<Map<string, Account>> {
  if (!ids.length) return new Map();
  const rows = await db.select().from(accounts).where(inArray(accounts.id, ids));
  return new Map(rows.map((a) => [a.id, a]));
}

export const CREDIT_KINDS = new Set(["credit_card", "line_of_credit"]);
