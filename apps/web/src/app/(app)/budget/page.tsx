import { monthOf, today as localToday } from "@homebase/shared";
import { parseMonthParam } from "@/lib/format";
import { requireUser } from "@/server/auth";
import { loadBucketMonth } from "@/server/queries/glow";
import { BudgetView } from "./BudgetView";

export const metadata = { title: "Budget" };

/** The bucket budget: one row per category, bars that show what's left this month. `?m=YYYY-MM` picks the month. */
export default async function BudgetPage({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  await requireUser();
  const { m } = await searchParams;
  const today = localToday();
  const current = monthOf(today);
  const month = parseMonthParam(m) ?? current;
  const data = await loadBucketMonth(month, today);
  return <BudgetView key={month} data={data} currentMonth={current} />;
}
