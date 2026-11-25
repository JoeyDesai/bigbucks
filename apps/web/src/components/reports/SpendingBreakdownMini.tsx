"use client";
import Link from "next/link";
import type { SpendingBreakdown } from "@homebase/core";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { DonutChart, DonutLegend } from "@/components/charts/DonutChart";

/** The Reports index aside: this month's spending donut (live), linking to the full breakdown. */
export function SpendingBreakdownMini({ data }: { data: SpendingBreakdown }) {
  const slices = data.donut.map((d) => ({ label: d.label, value: d.amount }));
  return (
    <ChartFrame
      title={`${data.period.label.split(" ")[0]} spending`}
      subtitle={`${data.period.label} to date · Household`}
      summary={`Spending by category this month`}
      height={220}
      footer={
        <>
          <DonutLegend data={slices} total={data.total} />
          <Link href="/reports/spending-breakdown" className="mt-3 inline-flex min-h-11 items-center text-[13px] text-ink-2 underline decoration-rule-strong underline-offset-4 hover:text-ink hover:decoration-ink">
            Full breakdown
          </Link>
        </>
      }
    >
      <DonutChart data={slices} centerLabel="Spent" centerValue={data.total} />
    </ChartFrame>
  );
}
