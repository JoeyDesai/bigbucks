/**
 * Which ledger lines a report counts, as SQL over `v_transactions_flat v`.
 *
 * Household (default): on-budget accounts of the household entity, the same rules as
 * v_cashflow_monthly / YNAB Reflect —
 *   income   = inflows categorized to Ready to Assign;
 *   spending = every other line, net of refunds, except uncategorized transfers (transfers between
 *              on-budget accounts and card payments). Categorized transfers to tracking accounts
 *              (retirement, mortgage) count as spending, as in YNAB.
 * Business: the business entity's accounts are tracking accounts with no categories, so
 *   income = non-transfer inflows; spending = non-transfer outflows (bucketed by payee).
 * Starting balances and pending rows never count.
 */
import { sql, type SQL } from "drizzle-orm";
import { categories } from "@homebase/db";
import { eq } from "drizzle-orm";
import type { DbLike } from "../context";
import { householdEntityId } from "../wealth/netWorth";
import type { ReportParams, ResolvedPeriod } from "./params";

export interface Scope {
  householdId: string | null;
  uncategorizedId: string | null;
  /** Lines in the period, entity and accounts (no income/spending split). */
  base: SQL;
  spend: SQL;
  income: SQL;
  /** Category bucket key / label (`category:<id>`, or `payee:<id>` for uncategorized business lines). */
  categoryKey: SQL;
  categoryLabel: SQL;
  groupKey: SQL;
  groupLabel: SQL;
}

export async function reportScope(db: DbLike, p: ReportParams, period: Pick<ResolvedPeriod, "from" | "to">): Promise<Scope> {
  const hh = await householdEntityId(db);
  const [unc] = await db.select({ id: categories.id }).from(categories).where(eq(categories.kind, "uncategorized")).limit(1);
  const uncId = unc?.id ?? null;
  const hhCond = hh ? sql`v.entity_id = ${hh}` : sql`TRUE`;
  const bizCond = hh ? sql`v.entity_id <> ${hh}` : sql`FALSE`;
  const household = sql`(${hhCond} AND v.on_budget)`;
  const business = sql`(${bizCond} AND NOT v.is_transfer)`;
  const entity = p.entity === "household" ? household : p.entity === "business" ? business : sql`(${household} OR ${business})`;
  const conds: SQL[] = [entity, sql`NOT v.is_starting_balance`, sql`v.cleared <> 'pending'`, sql`v.date >= ${period.from}`, sql`v.date <= ${period.to}`];
  if (p.accountIds?.length) conds.push(sql`v.account_id IN ${p.accountIds}`);
  const base = sql.join(conds, sql` AND `);
  const hhSpend = sql`(v.on_budget AND v.category_kind IS DISTINCT FROM 'internal_rta' AND NOT (v.is_transfer AND v.category_id IS NULL))`;
  const hhIncome = sql`(v.on_budget AND v.category_kind = 'internal_rta')`;
  const bizSpend = sql`(NOT v.on_budget AND v.amount_milli < 0)`;
  const bizIncome = sql`(NOT v.on_budget AND v.amount_milli > 0)`;
  const unc_ = uncId ? sql`${uncId}::text` : sql`'uncategorized'`;
  return {
    householdId: hh,
    uncategorizedId: uncId,
    base,
    spend: sql`(${base} AND (${hhSpend} OR ${bizSpend}))`,
    income: sql`(${base} AND (${hhIncome} OR ${bizIncome}))`,
    categoryKey: sql`CASE
      WHEN v.category_id IS NOT NULL AND v.category_kind <> 'uncategorized' THEN 'category:' || v.category_id::text
      WHEN NOT v.on_budget AND v.payee_id IS NOT NULL THEN 'payee:' || v.payee_id::text
      ELSE 'category:' || ${unc_} END`,
    categoryLabel: sql`CASE
      WHEN v.category_id IS NOT NULL AND v.category_kind <> 'uncategorized' THEN v.category_name
      WHEN NOT v.on_budget THEN coalesce(v.payee_name, 'Uncategorized')
      ELSE 'Uncategorized' END`,
    groupKey: sql`CASE
      WHEN v.category_id IS NOT NULL AND v.category_kind <> 'uncategorized' THEN 'group:' || v.group_id::text
      WHEN NOT v.on_budget THEN 'entity:' || v.entity_id::text
      ELSE 'category:' || ${unc_} END`,
    groupLabel: sql`CASE
      WHEN v.category_id IS NOT NULL AND v.category_kind <> 'uncategorized' THEN v.group_name
      WHEN NOT v.on_budget THEN v.entity_name
      ELSE 'Uncategorized' END`,
  };
}

/** The category ids a bucket key drills into (uncategorized business payee buckets drill by payee). */
export function drillForKey(key: string, categoryIds: (string | null)[] | null): { categoryIds?: string[]; payeeIds?: string[] } {
  if (key.startsWith("payee:")) return { payeeIds: [key.slice(6)] };
  if (key.startsWith("category:")) return { categoryIds: [key.slice(9)] };
  const ids = (categoryIds ?? []).filter((x): x is string => !!x);
  return ids.length ? { categoryIds: [...new Set(ids)].sort() } : {};
}
