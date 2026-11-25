import { today as localToday } from "@homebase/shared";
import { requireUser } from "@/server/auth";
import { INVEST_PERIODS, loadInvestments, type InvestPeriod } from "@/server/queries/investments";
import { InvestmentsView } from "./InvestmentsView";

export const metadata = { title: "Investments" };

/** Investments: every brokerage / retirement / HSA / crypto account. `?a=<id>` shows one account, `?p=1M|3M|YTD|1Y|ALL` the range. */
export default async function InvestmentsPage({ searchParams }: { searchParams: Promise<{ a?: string; p?: string }> }) {
  const { via } = await requireUser();
  const { a, p } = await searchParams;
  const period: InvestPeriod = INVEST_PERIODS.includes(p as InvestPeriod) ? (p as InvestPeriod) : "1Y";
  const data = await loadInvestments(period, a && /^[0-9a-f-]{36}$/.test(a) ? a : null, localToday());
  return <InvestmentsView data={data} demo={via === "demo"} />;
}
