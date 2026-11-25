import "server-only";
import { sql } from "drizzle-orm";
import { drillDown, householdEntityId, type ReportParams, type ReportTable, type ResolvedPeriod } from "@homebase/core";
import type { Db } from "@homebase/db";
import type { FilterAccount } from "@/components/reports/ReportFilters";
import type { UrlParams } from "@/components/reports/url";

/** Drill-down hrefs for every table row that has a target. */
export function tableHrefs(slug: string, table: ReportTable, period: ResolvedPeriod, params: ReportParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of table.rows) if (r.drill) out[r.key] = drillDown(slug, r.drill, { period, accountIds: params.accountIds }).href;
  return out;
}

/** Accounts for the filter picker, sectioned by entity. Spending-style reports list budget accounts (and the business's). */
export async function filterAccounts(db: Db, params: ReportParams, kind: "budget" | "all"): Promise<FilterAccount[]> {
  const hh = await householdEntityId(db);
  const r = await db.execute<{ id: string; name: string; entity_id: string; entity: string; on_budget: boolean; closed: boolean }>(sql`
    SELECT a.id, a.name, a.entity_id, e.name AS entity, a.on_budget, a.closed
    FROM accounts a JOIN entities e ON e.id = a.entity_id
    WHERE a.deleted_at IS NULL
    ORDER BY e.sort, a.sort, a.name`);
  return r.rows
    .filter((a) => params.entity === "all" || (params.entity === "household" ? a.entity_id === hh : a.entity_id !== hh))
    .filter((a) => kind === "all" || a.on_budget || a.entity_id !== hh)
    .map((a) => ({ id: a.id, name: a.closed ? `${a.name} (closed)` : a.name, section: a.entity === "Household" ? "Household" : a.entity }));
}

/** ReportParams → the client's URL params shape. */
export function urlParams(p: ReportParams): UrlParams {
  return {
    period: p.period,
    month: p.month,
    from: p.from,
    to: p.to,
    accountIds: p.accountIds,
    entity: p.entity,
    level: p.level,
    categoryId: p.categoryId,
    accountId: p.accountId,
  };
}

export const ENTITY_LABEL: Record<ReportParams["entity"], string> = { household: "Household", business: "Business", all: "Household and business" };
