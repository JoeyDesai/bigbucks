/** Payees (spec §5.1, §9.2, §12.6): list, rename, merge, default category, aliases. */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { payeeAliases, payees, scheduledTransactionSplits, scheduledTransactions, transactionSplits, transactions, type Payee, type PayeeAlias } from "@homebase/db";
import type { ISODate } from "@homebase/shared";
import { writeAudit } from "./audit";
import { beginBudgetWrite } from "./budget/cache";
import { ctxToday, withTx, type Ctx, type DbLike } from "./context";
import { ConflictError, NotFoundError, ValidationError, assertFound } from "./errors";
import { checkCategory, payeeKey } from "./transactions/common";

export interface PayeeSummary {
  id: string;
  name: string;
  normalizedKey: string;
  defaultCategoryId: string | null;
  defaultCategoryName: string | null;
  transferAccountId: string | null;
  merchant: Payee["merchant"];
  transactionCount: number;
  lastUsed: ISODate | null;
  aliasCount: number;
  deleted: boolean;
}

export async function listPayees(db: DbLike, opts: { q?: string; includeDeleted?: boolean; includeTransfer?: boolean; limit?: number } = {}): Promise<PayeeSummary[]> {
  const conds = [sql`TRUE`];
  if (!opts.includeDeleted) conds.push(sql`p.deleted_at IS NULL`);
  if (!opts.includeTransfer) conds.push(sql`p.transfer_account_id IS NULL`);
  if (opts.q) conds.push(sql`p.name ILIKE ${`%${opts.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`}`);
  const res = await db.execute<{
    id: string;
    name: string;
    normalized_key: string;
    default_category_id: string | null;
    default_category_name: string | null;
    transfer_account_id: string | null;
    merchant: Payee["merchant"];
    n: bigint;
    last_used: string | null;
    aliases: bigint;
    deleted_at: Date | string | null;
  }>(sql`
    SELECT p.id, p.name, p.normalized_key, p.default_category_id, c.name AS default_category_name, p.transfer_account_id, p.merchant, p.deleted_at,
      (SELECT count(*) FROM transactions t WHERE t.payee_id = p.id AND t.deleted_at IS NULL) AS n,
      (SELECT max(date) FROM transactions t WHERE t.payee_id = p.id AND t.deleted_at IS NULL) AS last_used,
      (SELECT count(*) FROM payee_aliases a WHERE a.payee_id = p.id) AS aliases
    FROM payees p LEFT JOIN categories c ON c.id = p.default_category_id
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY p.name
    LIMIT ${Math.min(opts.limit ?? 1000, 5000)}`);
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    normalizedKey: r.normalized_key,
    defaultCategoryId: r.default_category_id,
    defaultCategoryName: r.default_category_name,
    transferAccountId: r.transfer_account_id,
    merchant: r.merchant,
    transactionCount: Number(r.n),
    lastUsed: r.last_used,
    aliasCount: Number(r.aliases),
    deleted: r.deleted_at !== null,
  }));
}

export async function getPayee(db: DbLike, id: string): Promise<Payee & { aliases: PayeeAlias[] }> {
  const p = assertFound((await db.select().from(payees).where(eq(payees.id, id)))[0], "payee", id);
  const aliases = await db.select().from(payeeAliases).where(eq(payeeAliases.payeeId, id)).orderBy(asc(payeeAliases.pattern));
  return { ...p, aliases };
}

export async function renamePayee(ctx: Ctx, id: string, name: string): Promise<Payee> {
  const n = z.string().trim().min(1).max(200).parse(name);
  return withTx(ctx, async (tx, c) => {
    const p = assertFound((await tx.select().from(payees).where(eq(payees.id, id)))[0], "payee", id);
    if (p.transferAccountId) throw new ValidationError("transfer payees follow their account's name");
    const key = payeeKey(n);
    if (!key) throw new ValidationError("name is empty");
    const [clash] = await tx.select({ id: payees.id, name: payees.name }).from(payees).where(eq(payees.normalizedKey, key));
    if (clash && clash.id !== id) throw new ConflictError(`a payee named "${clash.name}" already exists (${clash.id}); merge them instead`);
    const [after] = await tx.update(payees).set({ name: n, normalizedKey: key }).where(eq(payees.id, id)).returning();
    await writeAudit(tx, c, { action: "payee.rename", entity: "payee", entityId: id, before: { name: p.name }, after: { name: n } });
    return after!;
  });
}

export async function setPayeeDefaultCategory(ctx: Ctx, id: string, categoryId: string | null): Promise<Payee> {
  return withTx(ctx, async (tx, c) => {
    const p = assertFound((await tx.select().from(payees).where(eq(payees.id, id)))[0], "payee", id);
    await checkCategory(tx, categoryId);
    const [after] = await tx.update(payees).set({ defaultCategoryId: categoryId }).where(eq(payees.id, id)).returning();
    await writeAudit(tx, c, { action: "payee.default_category", entity: "payee", entityId: id, before: { defaultCategoryId: p.defaultCategoryId }, after: { defaultCategoryId: categoryId } });
    return after!;
  });
}

/**
 * Merge payees into `targetId`: transactions, splits, scheduled transactions and aliases move over; the
 * target keeps its default category/merchant profile (or inherits the first source's). Each source gets
 * an exact alias on its name, and is soft-deleted with its key freed.
 */
export async function mergePayees(ctx: Ctx, input: { sourceIds: string[]; targetId: string }): Promise<{ targetId: string; moved: number }> {
  const sources = [...new Set(input.sourceIds)].filter((s) => s !== input.targetId);
  if (!sources.length) throw new ValidationError("nothing to merge");
  return withTx(ctx, async (tx, c) => {
    const w = await beginBudgetWrite(tx, ctxToday(c));
    const target = assertFound((await tx.select().from(payees).where(eq(payees.id, input.targetId)))[0], "payee", input.targetId);
    const srcRows = await tx.select().from(payees).where(inArray(payees.id, sources));
    if (srcRows.length !== sources.length) throw new NotFoundError("payee", sources.find((s) => !srcRows.some((r) => r.id === s))!);
    if (target.transferAccountId || srcRows.some((s) => s.transferAccountId)) throw new ValidationError("transfer payees can't be merged");
    const moved = await tx.update(transactions).set({ payeeId: target.id }).where(inArray(transactions.payeeId, sources)).returning({ id: transactions.id });
    await tx.update(transactionSplits).set({ payeeId: target.id }).where(inArray(transactionSplits.payeeId, sources));
    await tx.update(scheduledTransactions).set({ payeeId: target.id }).where(inArray(scheduledTransactions.payeeId, sources));
    await tx.update(scheduledTransactionSplits).set({ payeeId: target.id }).where(inArray(scheduledTransactionSplits.payeeId, sources));
    await tx.update(payeeAliases).set({ payeeId: target.id }).where(inArray(payeeAliases.payeeId, sources));
    const inherit: Partial<typeof payees.$inferInsert> = {};
    if (!target.defaultCategoryId) inherit.defaultCategoryId = srcRows.find((s) => s.defaultCategoryId)?.defaultCategoryId ?? null;
    if (!target.merchant) inherit.merchant = srcRows.find((s) => s.merchant)?.merchant ?? null;
    if (Object.keys(inherit).length) await tx.update(payees).set(inherit).where(eq(payees.id, target.id));
    for (const s of srcRows) {
      await tx.update(payees).set({ deletedAt: new Date(), normalizedKey: `merged ${s.id}` }).where(eq(payees.id, s.id));
      await tx.insert(payeeAliases).values({ pattern: s.name, match: "exact", payeeId: target.id }).onConflictDoNothing();
    }
    await writeAudit(tx, c, { action: "payee.merge", entity: "payee", entityId: target.id, before: srcRows.map((s) => ({ id: s.id, name: s.name })), after: { targetId: target.id, moved: moved.length } });
    await w.finish(null);
    return { targetId: target.id, moved: moved.length };
  });
}

// ── aliases ─────────────────────────────────────────────────────────────────

export const AliasSchema = z
  .object({
    payeeId: z.string().uuid(),
    pattern: z.string().trim().min(1).max(300),
    match: z.enum(["exact", "prefix", "regex"]),
  })
  .superRefine((a, c) => {
    if (a.match === "regex") {
      try {
        new RegExp(a.pattern);
      } catch (e) {
        c.addIssue({ code: "custom", path: ["pattern"], message: `invalid regex: ${(e as Error).message}` });
      }
    }
  });
export type AliasInput = z.input<typeof AliasSchema>;

export async function listAliases(db: DbLike, payeeId?: string): Promise<(PayeeAlias & { payeeName: string })[]> {
  const rows = await db
    .select({ a: payeeAliases, payeeName: payees.name })
    .from(payeeAliases)
    .innerJoin(payees, eq(payees.id, payeeAliases.payeeId))
    .where(payeeId ? eq(payeeAliases.payeeId, payeeId) : undefined)
    .orderBy(asc(payees.name), asc(payeeAliases.pattern));
  return rows.map((r) => ({ ...r.a, payeeName: r.payeeName }));
}

async function aliasInsertOrConflict<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { code?: string; cause?: { code?: string } }).code === "23505" || (e as { cause?: { code?: string } }).cause?.code === "23505") throw new ConflictError("an alias with that pattern already exists");
    throw e;
  }
}

export async function createAlias(ctx: Ctx, input: AliasInput): Promise<PayeeAlias> {
  const a = AliasSchema.parse(input);
  return withTx(ctx, async (tx, c) => {
    assertFound((await tx.select({ id: payees.id }).from(payees).where(and(eq(payees.id, a.payeeId), isNull(payees.deletedAt))))[0], "payee", a.payeeId);
    const [row] = await aliasInsertOrConflict(() => tx.insert(payeeAliases).values(a).returning());
    await writeAudit(tx, c, { action: "payee.alias_create", entity: "payee_alias", entityId: row!.id, after: row });
    return row!;
  });
}

export async function updateAlias(ctx: Ctx, id: string, patch: Partial<AliasInput>): Promise<PayeeAlias> {
  return withTx(ctx, async (tx, c) => {
    const before = assertFound((await tx.select().from(payeeAliases).where(eq(payeeAliases.id, id)))[0], "payee alias", id);
    const next = AliasSchema.parse({ payeeId: before.payeeId, pattern: before.pattern, match: before.match, ...patch });
    const [row] = await aliasInsertOrConflict(() => tx.update(payeeAliases).set(next).where(eq(payeeAliases.id, id)).returning());
    await writeAudit(tx, c, { action: "payee.alias_update", entity: "payee_alias", entityId: id, before, after: row });
    return row!;
  });
}

export async function deleteAlias(ctx: Ctx, id: string): Promise<void> {
  await withTx(ctx, async (tx, c) => {
    const [row] = await tx.delete(payeeAliases).where(eq(payeeAliases.id, id)).returning();
    if (!row) throw new NotFoundError("payee alias", id);
    await writeAudit(tx, c, { action: "payee.alias_delete", entity: "payee_alias", entityId: id, before: row });
  });
}

