"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { ArrowDownRight, ArrowUpRight, ChevronRight } from "lucide-react";
import { formatMilli } from "@homebase/shared";
import type { WealthSection } from "@homebase/core";
import { cx } from "@/lib/cx";
import { formatDay, sourceLabel, timeAgo } from "@/lib/format";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { AreaChart, StackedBarChart } from "@/components/charts/CartesianCharts";
import { fmtMonthTick } from "@/components/charts/util";
import { PageHeader } from "@/components/shell/PageHeader";
import { Money } from "@/components/ui/Money";
import { PullToRefresh } from "@/components/ui/PullToRefresh";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { StatusDot } from "@/components/ui/StatusDot";

export type Period = "1M" | "3M" | "YTD" | "1Y" | "ALL";
const STATUS = { green: "ok", yellow: "needs_attention", red: "error", gray: "manual" } as const;

export interface WealthViewProps {
  period: Period;
  business: boolean;
  businessAvailable: boolean;
  headline: { asOf: string; netWorth: bigint; assets: bigint; liabilities: bigint; changeVsLastMonth: bigint; changeBps: number | null };
  series: { date: string; assets: bigint; liabilities: bigint; net: bigint }[];
  sections: WealthSection[];
  growth: { month: string; contributions: bigint; market: bigint; known: boolean }[];
  growthTotals: { change: bigint; contributions: bigint; marketChange: bigint };
  today: string;
}

const dayTick = (d: string) => (d.length === 10 ? `${fmtMonthTick(`${d.slice(0, 7)}-01`)} ${Number(d.slice(8))}` : d);
/** Month-end points show the month; any other date (period start, today) shows the day too. */
const monthEndTick = (d: string) => {
  const m = `${d.slice(0, 7)}-01`;
  const next = new Date(`${m}T12:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1, 0);
  return next.toISOString().slice(0, 10) === d ? fmtMonthTick(m) : dayTick(d);
};

export function WealthView({ period, business, businessAvailable, headline, series, sections, growth, growthTotals }: WealthViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const up = headline.changeVsLastMonth >= 0n;
  const go = (p: Period, r: boolean) => start(() => router.replace(`${pathname}?p=${p}${r ? "&r=1" : ""}`, { scroll: false }));
  const pct = headline.changeBps === null ? null : (headline.changeBps / 100).toFixed(1);

  return (
    <PullToRefresh onRefresh={() => router.refresh()}>
      <PageHeader title="Wealth" />
      <div className="px-4 lg:px-8">
        <section aria-label="Net worth" className="border-b border-rule pb-6">
          <div className="eyebrow">Net worth{business ? " · including business accounts" : ""}</div>
          <Money value={headline.netWorth} display animate className="mt-1 block text-[44px] leading-none lg:text-[56px]" />
          <p className={cx("mt-2 inline-flex flex-wrap items-center gap-1 text-[14px]", up ? "text-pos" : "text-neg")}>
            {up ? <ArrowUpRight size={16} strokeWidth={2} aria-hidden /> : <ArrowDownRight size={16} strokeWidth={2} aria-hidden />}
            <span className="num">{formatMilli(headline.changeVsLastMonth, { sign: "always" })}</span>
            {pct && <span className="num">({up ? "+" : ""}{pct}%)</span>}
            <span className="text-ink-3">since the end of last month</span>
          </p>
          <dl className="mt-3 flex gap-6 text-[13px]">
            <div>
              <dt className="text-ink-3">Assets</dt>
              <dd className="num text-ink">{formatMilli(headline.assets, { cents: false })}</dd>
            </div>
            <div>
              <dt className="text-ink-3">Liabilities</dt>
              <dd className="num text-neg">{formatMilli(-headline.liabilities, { cents: false })}</dd>
            </div>
          </dl>

          <ChartFrame
            className={cx("mt-6 transition-opacity", pending && "opacity-60")}
            height={220}
            summary={`Net worth over ${period}: assets and liabilities with a net line.`}
            title="Assets and liabilities"
            actions={<SegmentedControl<Period> label="Period" size="sm" value={period} onChange={(p) => go(p, business)} options={(["1M", "3M", "YTD", "1Y", "ALL"] as Period[]).map((p) => ({ value: p, label: p === "ALL" ? "All" : p }))} />}
          >
            <AreaChart
              data={series}
              xKey="date"
              stacked={false}
              xFormat={period === "1M" || period === "3M" ? dayTick : monthEndTick}
              series={[
                { key: "assets", label: "Assets" },
                { key: "liabilities", label: "Liabilities", color: "var(--neg-bar)" },
              ]}
              line={{ key: "net", label: "Net worth" }}
            />
          </ChartFrame>
        </section>

        {businessAvailable && (
          <div className="flex items-center justify-between py-4">
            <span className="text-[13px] text-ink-2">Business accounts</span>
            <SegmentedControl
              label="Include business accounts"
              size="sm"
              value={business ? "on" : "off"}
              onChange={(v) => go(period, v === "on")}
              options={[
                { value: "off", label: "Hide" },
                { value: "on", label: "Show" },
              ]}
            />
          </div>
        )}

        <div className={cx("grid gap-x-12 lg:grid-cols-2", !businessAvailable && "pt-6")}>
          {sections.map((s) => (
            <section key={s.key} aria-label={s.title} className="mb-8">
              <div className="flex items-baseline justify-between border-b border-rule-strong pb-1.5">
                <h2 className="display text-[19px]">{s.title}</h2>
                <Money value={s.total} tone={s.total < 0n ? "neg" : "ink"} className="text-[14px] font-medium" />
              </div>
              <ul>
                {s.accounts.map((a) => (
                  <li key={a.id} className="border-b border-rule">
                    <Link href={`/wealth/${a.id}`} className="group flex min-h-[56px] items-center gap-3 py-2">
                      <StatusDot status={STATUS[a.statusColor]} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px]">{a.displayName}</span>
                        <span className="block truncate text-[12px] text-ink-3">
                          {a.institution ?? sourceLabel(a.source)}
                          {a.lastSyncAt ? ` · ${timeAgo(new Date(a.lastSyncAt).toISOString())}` : a.syncedAsOf ? ` · ${formatDay(a.syncedAsOf)}` : ""}
                        </span>
                      </span>
                      <span className="text-right">
                        <Money value={a.balance} tone={a.balance < 0n ? "neg" : "ink"} className="block" />
                        {a.changeVsLastMonth !== null && a.changeVsLastMonth !== 0n && (
                          <Money value={a.changeVsLastMonth} tone="signed" sign="always" className="block text-[11px]" />
                        )}
                      </span>
                      <ChevronRight size={16} strokeWidth={1.75} aria-hidden className="text-ink-3" />
                    </Link>
                    {a.home && (
                      <p className="-mt-1 pb-3 pl-5 text-[12px] text-ink-2">
                        {a.home.low !== null && a.home.high !== null && (
                          <>
                            Range {formatMilli(a.home.low, { cents: false })} – {formatMilli(a.home.high, { cents: false })} ·{" "}
                          </>
                        )}
                        equity <span className="num font-medium text-ink">{a.home.equity !== null ? formatMilli(a.home.equity, { cents: false }) : "—"}</span>
                      </p>
                    )}
                    {a.mortgage && (
                      <p className="-mt-1 pb-3 pl-5 text-[12px] text-ink-2">
                        {a.mortgage.payoffDate ? `Paid off ${formatDay(a.mortgage.payoffDate, { withYear: true })}` : "Payoff date unknown"}
                        {a.mortgage.driftFlagged && <span className="text-warn"> · bank balance differs from the schedule</span>}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        {growth.length > 0 && (
          <section aria-label="Investment growth" className="mt-4 border-t border-rule pt-6">
            <ChartFrame
              title="Investment growth"
              subtitle={
                <>
                  Last 12 months: <span className="num text-ink">{formatMilli(growthTotals.contributions, { cents: false })}</span> contributed,{" "}
                  <span className={cx("num", growthTotals.marketChange >= 0n ? "text-pos" : "text-neg")}>{formatMilli(growthTotals.marketChange, { sign: "always", cents: false })}</span> market change
                </>
              }
              summary="Monthly investment growth split into contributions and market change"
              height={220}
            >
              <StackedBarChart
                data={growth.map((g) => ({ month: g.month, contributions: g.contributions, market: g.market }))}
                xKey="month"
                series={[
                  { key: "contributions", label: "Contributions" },
                  { key: "market", label: "Market change", color: "var(--chart-3)" },
                ]}
              />
            </ChartFrame>
            {growth.some((g) => !g.known) && <p className="mt-2 text-[12px] text-ink-3">Some months have no known contribution source, so their market change includes contributions.</p>}
          </section>
        )}
      </div>
    </PullToRefresh>
  );
}
