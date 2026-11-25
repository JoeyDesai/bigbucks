/**
 * Reconcile (spec §6.8, §6.2): enter the bank's statement balance; if it differs from the cleared balance,
 * create an adjustment (cash → Ready to Assign, card → the card's payment category, tracking → none),
 * then lock every cleared transaction as reconciled.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { categories, reconciliations, transactions, type Transaction } from "@homebase/db";
import type { ISODate, Milli } from "@homebase/shared";
import { writeAudit } from "../audit";
import { beginBudgetWrite } from "../budget/cache";
import { ctxToday, withTx, type Ctx, type DbLike } from "../context";
import { ValidationError } from "../errors";
import { CREDIT_KINDS, getAccountOrThrow, minMonth, resolvePayee } from "./common";

export const RECONCILIATION_PAYEE = "Reconciliation Balance Adjustment";

export async function clearedBalance(db: DbLike, accountId: string): Promise<Milli> {
  const res = await db.execute<{ bal: bigint }>(
    sql`SELECT coalesce(sum(amount_milli), 0)::bigint AS bal FROM transactions WHERE account_id = ${accountId} AND deleted_at IS NULL AND cleared IN ('cleared', 'reconciled')`,
  );
  return BigInt(res.rows[0]!.bal);
}

export interface ReconcileResult {
  reconciliationId: string;
  clearedBalance: Milli;
  statementBalance: Milli;
  /** statement − cleared (the adjustment amount; 0 = already balanced). */
  difference: Milli;
  adjustment: Transaction | null;
  /** Transactions moved from cleared → reconciled (the adjustment included). */
  reconciledCount: number;
}

export async function reconcile(ctx: Ctx, input: { accountId: string; statementBalance: Milli; statementDate?: ISODate }): Promise<ReconcileResult> {
  return withTx(ctx, async (tx, c) => {
    const today = ctxToday(c);
    const w = await beginBudgetWrite(tx, today);
    const acct = await getAccountOrThrow(tx, input.accountId);
    if (acct.closed) throw new ValidationError("account is closed");
    const cleared = await clearedBalance(tx, acct.id);
    const difference = input.statementBalance - cleared;
    const date = input.statementDate ?? today;
    let adjustment: Transaction | null = null;
    if (difference !== 0n) {
      let categoryId: string | null = null;
      if (acct.onBudget) {
        const kind = CREDIT_KINDS.has(acct.kind) ? "cc_payment" : "internal_rta";
        const [cat] = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(kind === "cc_payment" ? and(eq(categories.kind, "cc_payment"), eq(categories.linkedAccountId, acct.id), isNull(categories.deletedAt)) : eq(categories.kind, "internal_rta"));
        categoryId = cat?.id ?? null;
      }
      const [row] = await tx
        .insert(transactions)
        .values({
          accountId: acct.id,
          date,
          amountMilli: difference,
          payeeId: await resolvePayee(tx, { payeeName: RECONCILIATION_PAYEE }),
          memo: "Reconciliation adjustment",
          categoryId,
          cleared: "cleared",
          approved: true,
          source: "reconciliation",
        })
        .returning();
      adjustment = row!;
    }
    const locked = await tx
      .update(transactions)
      .set({ cleared: "reconciled" })
      .where(and(eq(transactions.accountId, acct.id), eq(transactions.cleared, "cleared"), isNull(transactions.deletedAt)))
      .returning({ id: transactions.id });
    if (adjustment) adjustment = { ...adjustment, cleared: "reconciled" };
    const [rec] = await tx
      .insert(reconciliations)
      .values({ accountId: acct.id, statementDate: input.statementDate ?? null, statementBalanceMilli: input.statementBalance, clearedBalanceMilli: cleared, adjustmentTxId: adjustment?.id ?? null, userId: c.userId })
      .returning({ id: reconciliations.id });
    await writeAudit(tx, c, {
      action: "account.reconcile",
      entity: "account",
      entityId: acct.id,
      before: { clearedBalance: cleared },
      after: { statementBalance: input.statementBalance, difference, adjustmentTxId: adjustment?.id ?? null, reconciled: locked.length },
    });
    await w.finish(adjustment ? minMonth(date) : null);
    return { reconciliationId: rec!.id, clearedBalance: cleared, statementBalance: input.statementBalance, difference, adjustment, reconciledCount: locked.length };
  });
}

export async function lastReconciliation(db: DbLike, accountId: string) {
  const [r] = await db.select().from(reconciliations).where(eq(reconciliations.accountId, accountId)).orderBy(desc(reconciliations.at)).limit(1);
  return r ?? null;
}
