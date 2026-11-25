import { accountsBySection, investmentGrowth, netWorth, type NetWorthPeriod } from "@homebase/core";
import { today as localToday } from "@homebase/shared";
import { getDb } from "@/server/db";
import { requireUser } from "@/server/auth";
import { displayBalance } from "@/server/queries/transactions";
import { WealthView, type Period } from "./WealthView";

export const metadata = { title: "Wealth" };

const PERIODS: Period[] = ["1M", "3M", "YTD", "1Y", "ALL"];

export default async function WealthPage({ searchParams }: { searchParams: Promise<{ p?: string; r?: string }> }) {
  await requireUser();
  const sp = await searchParams;
  const period: Period = PERIODS.includes(sp.p as Period) ? (sp.p as Period) : "1Y";
  const business = sp.r === "1";
  const today = localToday();
  const db = getDb();
  const granularity = period === "1M" ? "day" : period === "3M" ? "week" : "month";
  const nw = await netWorth(db, { period: period as NetWorthPeriod, granularity, includeBusiness: business, today });
  const { sections, businessAvailable } = await accountsBySection(db, { includeBusiness: business, today });
  const growth = await investmentGrowth(db, null, 12, { today });
  return (
    <WealthView
      period={period}
      business={business}
      businessAvailable={businessAvailable}
      headline={nw.headline}
      series={nw.series.map((p) => ({ date: p.date, assets: p.assets, liabilities: -p.liabilities, net: p.netWorth }))}
      sections={sections.map((s) => {
        const accounts = s.accounts.map((a) => {
          const balance = displayBalance(a);
          return { ...a, balance, changeVsLastMonth: a.lastMonthBalance === null ? null : balance - a.lastMonthBalance };
        });
        return { ...s, accounts, total: accounts.reduce((t, a) => t + a.balance, 0n) };
      })}
      growth={growth.months.map((m) => ({ month: m.month, contributions: m.contributions, market: m.marketChange, known: m.contributionsKnown }))}
      growthTotals={growth.totals}
      today={today}
    />
  );
}
