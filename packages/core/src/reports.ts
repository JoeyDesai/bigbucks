/**
 * Report helpers: `spendingSummary` (§11.3 tool, §13 report 1) and saved reports (§11.3 `save_report`,
 * §13 report 12). Spending reads the v_transactions_flat view so it agrees with what the AI's SQL sees.
 */
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { savedReports, type SavedReport } from "@homebase/db";
import type { ISODate, Milli } from "@homebase/shared";
import { writeAudit } from "./audit";
import { withTx, type Ctx, type DbLike } from "./context";
import { NotFoundError } from "./errors";
import { householdEntityId } from "./wealth/netWorth";

export type SpendingGroupBy = "category" | "group" | "payee" | "month" | "account";

export interface SpendingFilters {
  accountIds?: string[];
  categoryIds?: string[];
  groupIds?: string[];
  payeeIds?: string[];
  includeBusiness?: boolean;
}

export interface SpendingRow {
  key: string | null;
  label: string;
  /** Net spending (outflows − refunds), positive = money spent. */
  amount: Milli;
  count: number;
}

export interface SpendingSummary {
  from: ISODate;
  to: ISODate;
  groupBy: SpendingGroupBy;
  total: Milli;
  rows: SpendingRow[];
}

/**
 * Net spending in [from, to] on budget accounts: every categorized/uncategorized line except Ready to
 * Assign income, uncategorized transfers, starting balances and pending rows (same rules as
 * v_cashflow_monthly's expense).
 */
export async function spendingSummary(db: DbLike, input: { groupBy: SpendingGroupBy; from: ISODate; to: ISODate; filters?: SpendingFilters }): Promise<SpendingSummary> {
  const f = input.filters ?? {};
  const conds: SQL[] = [
    sql`v.on_budget`,
    sql`NOT v.is_starting_balance`,
    sql`v.cleared <> 'pending'`,
    sql`v.category_kind IS DISTINCT FROM 'internal_rta'`,
    sql`NOT (v.is_transfer AND v.category_id IS NULL)`,
    sql`v.date >= ${input.from}`,
    sql`v.date <= ${input.to}`,
  ];
  if (!f.includeBusiness) {
    const hh = await householdEntityId(db);
    if (hh) conds.push(sql`v.entity_id = ${hh}`);
  }
  if (f.accountIds?.length) conds.push(sql`v.account_id IN ${f.accountIds}`);
  if (f.categoryIds?.length) conds.push(sql`v.category_id IN ${f.categoryIds}`);
  if (f.groupIds?.length) conds.push(sql`v.group_id IN ${f.groupIds}`);
  if (f.payeeIds?.length) conds.push(sql`v.payee_id IN ${f.payeeIds}`);
  const [key, label] = {
    category: [sql`v.category_id::text`, sql`coalesce(v.category_name, 'Uncategorized')`],
    group: [sql`v.group_id::text`, sql`coalesce(v.group_name, 'Uncategorized')`],
    payee: [sql`v.payee_id::text`, sql`coalesce(v.payee_name, '(no payee)')`],
    month: [sql`v.month::text`, sql`to_char(v.month, 'Mon YYYY')`],
    account: [sql`v.account_id::text`, sql`v.account_name`],
  }[input.groupBy];
  const res = await db.execute<{ key: string | null; label: string; amount: bigint; n: bigint }>(sql`
    SELECT ${key} AS key, ${label} AS label, (-sum(v.amount_milli))::bigint AS amount, count(*)::bigint AS n
    FROM v_transactions_flat v
    WHERE ${sql.join(conds, sql` AND `)}
    GROUP BY 1, 2
    ORDER BY ${input.groupBy === "month" ? sql`1 ASC` : sql`3 DESC`}`);
  const rows = res.rows.map((r) => ({ key: r.key, label: r.label, amount: BigInt(r.amount), count: Number(r.n) }));
  return { from: input.from, to: input.to, groupBy: input.groupBy, total: rows.reduce((s, r) => s + r.amount, 0n), rows };
}

// ── saved reports ───────────────────────────────────────────────────────────

const ReportSchema = z.object({ name: z.string().trim().min(1).max(200), spec: z.record(z.string(), z.unknown()), pinned: z.boolean().default(false) });

export async function listSavedReports(db: DbLike): Promise<SavedReport[]> {
  return db.select().from(savedReports).orderBy(desc(savedReports.pinned), asc(savedReports.name));
}

export async function saveReport(ctx: Ctx, input: z.input<typeof ReportSchema>): Promise<SavedReport> {
  const r = ReportSchema.parse(input);
  return withTx(ctx, async (tx, c) => {
    const [row] = await tx.insert(savedReports).values({ name: r.name, spec: r.spec, pinned: r.pinned, createdBy: c.userId }).returning();
    await writeAudit(tx, c, { action: "report.save", entity: "saved_report", entityId: row!.id, after: { name: r.name } });
    return row!;
  });
}

export async function updateSavedReport(ctx: Ctx, id: string, patch: Partial<z.input<typeof ReportSchema>>): Promise<SavedReport> {
  return withTx(ctx, async (tx, c) => {
    const [before] = await tx.select().from(savedReports).where(eq(savedReports.id, id));
    if (!before) throw new NotFoundError("saved report", id);
    const next = ReportSchema.parse({ name: before.name, spec: before.spec, pinned: before.pinned, ...patch });
    const [row] = await tx.update(savedReports).set(next).where(eq(savedReports.id, id)).returning();
    await writeAudit(tx, c, { action: "report.update", entity: "saved_report", entityId: id, before: { name: before.name, pinned: before.pinned }, after: { name: next.name, pinned: next.pinned } });
    return row!;
  });
}

export async function deleteSavedReport(ctx: Ctx, id: string): Promise<void> {
  await withTx(ctx, async (tx, c) => {
    const [row] = await tx.delete(savedReports).where(and(eq(savedReports.id, id))).returning();
    if (!row) throw new NotFoundError("saved report", id);
    await writeAudit(tx, c, { action: "report.delete", entity: "saved_report", entityId: id, before: { name: row.name } });
  });
}
