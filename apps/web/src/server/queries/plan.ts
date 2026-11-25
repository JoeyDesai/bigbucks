import "server-only";
import { getBudgetMonth, listCategories, listRecentMoves, type PlanCategory } from "@homebase/core";
import { formatMonth, monthOf, type Month } from "@homebase/shared";
import { sql } from "drizzle-orm";
import type { CategoryOption, CategoryVM, GroupVM, MonthSummaryVM } from "@/lib/view-models";
import { getDb } from "../db";
import { formatDay } from "@/lib/format";

export function toCategoryVM(c: PlanCategory): CategoryVM {
  const t = c.target;
  return {
    id: c.id,
    groupId: c.groupId,
    name: c.name,
    icon: (c as { icon?: string | null }).icon ?? null,
    kind: c.kind,
    assigned: c.assigned,
    activity: c.activity,
    available: c.available,
    carryIn: c.carryIn,
    cashSpending: c.cashSpending,
    creditSpending: c.creditSpending,
    cashOverspend: c.cashOverspend,
    creditOverspend: c.creditOverspend,
    upcoming: c.upcoming,
    note: c.note ?? undefined,
    hidden: c.hidden,
    pill: c.pill,
    statusLabel: c.statusLabel,
    linkedAccountId: c.linkedAccountId,
    suggestedPayment: c.payment?.suggestedPayment,
    target: t
      ? {
          type: t.type,
          description: t.label,
          amount: t.amount,
          needed: c.needed,
          underfunded: c.underfunded,
          snoozed: t.snoozed,
          ...(t.targetDate ? { dueLabel: formatDay(t.targetDate, { withYear: t.targetDate.slice(0, 4) !== new Date().getFullYear().toString() }) } : {}),
          fields: {
            type: t.type,
            amount: t.amount,
            cadence: t.cadence,
            cadenceEvery: t.cadenceEvery,
            day: t.day,
            targetDate: t.targetDate,
            percent: t.percent,
          },
        }
      : null,
  };
}

export interface RecentMoveVM {
  id: string;
  at: string;
  userName: string | null;
  description: string;
  undone: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export interface PlanData {
  month: Month;
  label: string;
  groups: GroupVM[];
  /** Hidden categories (still in the math). */
  hidden: CategoryVM[];
  recentMoves: RecentMoveVM[];
  summary: MonthSummaryVM;
  range: { first: Month | null; last: Month };
}

export async function loadPlan(month: Month, today: string): Promise<PlanData> {
  const v = await getBudgetMonth(getDb(), month, { today });
  return {
    month,
    label: v.label,
    range: v.range,
    groups: v.groups.map((g) => ({ id: g.id, name: g.name, pinned: g.isCreditCardPayments, categories: g.categories.map(toCategoryVM) })),
    hidden: v.hidden.map(toCategoryVM),
    recentMoves: (await listRecentMoves(getDb(), month, { limit: 25 })).map((m) => ({
      id: m.id,
      at: new Date(m.at).toISOString(),
      userName: m.userName,
      description: m.description,
      undone: m.undone,
      canUndo: m.canUndo,
      canRedo: m.canRedo,
    })),
    summary: {
      month,
      readyToAssign: v.summary.readyToAssign,
      leftOverFromLastMonth: v.summary.leftOverFromLastMonth,
      assignedThisMonth: v.summary.assigned,
      activity: v.summary.activity,
      available: v.summary.available,
      costToBeMe: v.summary.costToBeMe,
      assignedInFutureMonths: v.summary.assignedInFuture,
      ageOfMoneyDays: v.summary.ageOfMoney,
      note: v.monthNote ?? undefined,
      rtaLeftOver: v.summary.rtaLeftOverFromLastMonth,
      income: v.summary.income,
      uncategorized: v.uncategorized ? { id: v.uncategorized.id, activity: v.uncategorized.activity, available: v.uncategorized.available } : null,
    },
  };
}

/** Categories for pickers (visible groups, plus "Inflow: Ready to Assign"), with this month's Available. */
export async function loadCategoryOptions(month: Month, today: string): Promise<CategoryOption[]> {
  const db = getDb();
  const [groups, view] = [await listCategories(db), await getBudgetMonth(db, month, { today })];
  const avail = new Map(view.groups.flatMap((g) => g.categories).map((c) => [c.id, c.available]));
  const out: CategoryOption[] = [];
  for (const g of groups) {
    for (const c of g.categories) {
      if (c.kind === "uncategorized") continue;
      out.push({ id: c.id, name: c.kind === "internal_rta" ? "Inflow: Ready to Assign" : c.name, groupName: c.kind === "internal_rta" ? "Inflow" : g.name, icon: (c as { icon?: string | null }).icon ?? null, available: avail.get(c.id) });
    }
  }
  // Inflow first, then the Plan order
  return [...out.filter((o) => o.groupName === "Inflow"), ...out.filter((o) => o.groupName !== "Inflow")];
}

/** Category ids this user picked most recently (from categorization events), newest first. */
export async function loadRecentCategoryIds(userId: string, limit = 6): Promise<string[]> {
  const res = await getDb().execute<{ id: string }>(sql`
    SELECT final_category_id AS id FROM categorization_events
    WHERE user_id = ${userId} AND final_category_id IS NOT NULL
    GROUP BY final_category_id ORDER BY max(at) DESC LIMIT ${limit}`);
  if (res.rows.length >= 3) return res.rows.map((r) => r.id);
  // Fallback for a fresh install: most-used categories over the last 60 days.
  const freq = await getDb().execute<{ id: string }>(sql`
    SELECT category_id AS id FROM transactions
    WHERE category_id IS NOT NULL AND deleted_at IS NULL AND date > (now() - interval '60 days')::date
    GROUP BY category_id ORDER BY count(*) DESC LIMIT ${limit}`);
  return [...new Set([...res.rows.map((r) => r.id), ...freq.rows.map((r) => r.id)])].slice(0, limit);
}

export const monthLabel = (m: Month) => formatMonth(m);
export const thisMonth = (today: string) => monthOf(today);
