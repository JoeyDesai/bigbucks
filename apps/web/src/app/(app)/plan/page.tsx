import { monthOf, today as localToday } from "@homebase/shared";
import { parseMonthParam } from "@/lib/format";
import { isAdmin, requireUser } from "@/server/auth";
import { loadCategoryOptions, loadPlan, loadRecentCategoryIds } from "@/server/queries/plan";
import { loadScheduled } from "@/server/queries/scheduled";
import { loadAccounts } from "@/server/queries/transactions";
import { PlanView } from "./PlanView";

export const metadata = { title: "Plan" };

export default async function PlanPage({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  const cu = await requireUser();
  const { m } = await searchParams;
  const today = localToday();
  const current = monthOf(today);
  const month = parseMonthParam(m) ?? current;
  const plan = await loadPlan(month, today);
  const [options, recent] = [await loadCategoryOptions(month, today), await loadRecentCategoryIds(cu.user.id)];
  const scheduled = await loadScheduled(today);
  const { accounts } = await loadAccounts(today);
  return (
    <PlanView
      key={month}
      month={month}
      today={current}
      plan={plan}
      categoryOptions={options}
      recentCategoryIds={recent}
      scheduled={scheduled}
      hasBudgetAccounts={accounts.some((a) => a.onBudget)}
      admin={isAdmin(cu)}
    />
  );
}
