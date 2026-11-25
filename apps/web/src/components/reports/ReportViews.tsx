"use client";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import type {
  AgeOfMoneyReport,
  BudgetPerformanceReport,
  CashFlowSankey,
  CategoryDetailReport,
  IncomeVsExpense,
  InvestmentGrowthReport,
  NetWorthReport,
  PayeesReport,
  SpendingBreakdown,
  SpendingTrends,
  SubscriptionsReport,
} from "@homebase/core";
import { formatMilli } from "@homebase/shared";
import { cx } from "@/lib/cx";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { AreaChart, LineChart, StackedBarChart } from "@/components/charts/CartesianCharts";
import { ComboChart } from "@/components/charts/ComboChart";
import { DonutChart } from "@/components/charts/DonutChart";
import { RankBars, rankBarsHeight } from "@/components/charts/RankBars";
import { SankeyChart } from "@/components/charts/SankeyChart";
import { fmtCompact, fmtMonthTick } from "@/components/charts/util";
import { Money } from "@/components/ui/Money";
import { CategoryIcon } from "@/components/icons/CategoryIcon";
import { categoryLabel } from "@/lib/category-icons";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { sliceColors } from "./colors";
import { bpsLabel, dayLabel, monthLabel } from "./url";

// ── shared bits ─────────────────────────────────────────────────────────────

export interface StatItem {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}

/** Headline figures: small white cards with a label over a bold number. */
export function Stats({ items, className }: { items: StatItem[]; className?: string }) {
  return (
    <dl className={cx("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}>
      {items.map((s) => (
        <div key={s.label} className="card min-w-0 px-4 py-3">
          <dt className="text-[12.5px] font-semibold text-ink-3">{s.label}</dt>
          <dd className="display num mt-0.5 truncate text-[20px] leading-tight text-ink lg:text-[22px]">{s.value}</dd>
          {s.note && <dd className="mt-0.5 truncate text-[12px] text-ink-3">{s.note}</dd>}
        </div>
      ))}
    </dl>
  );
}

const money = (m: bigint, cents = false) => formatMilli(m, { cents });
const days = { tick: (n: number) => `${Math.round(n)}d`, tooltip: (n: number) => `${Math.round(n)} days` };

const PHONE = "(max-width: 640px)";
const subscribePhone = (cb: () => void) => {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

/** Chart heights: phones get a shorter plot (server render assumes desktop). */
function useIsPhone(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

function Chart({ children, className, ...p }: Parameters<typeof ChartFrame>[0]) {
  return (
    <div data-report-chart className={className}>
      <ChartFrame {...p}>{children}</ChartFrame>
    </div>
  );
}

const EMPTY = <p className="py-16 text-center text-[14px] text-ink-3">Nothing to chart in this period.</p>;

// ── 1. spending breakdown ───────────────────────────────────────────────────

export function SpendingBreakdownView({ data, hrefs, icons = {} }: { data: SpendingBreakdown; hrefs: Record<string, string>; icons?: Record<string, string | null> }) {
  const colors = sliceColors(data);
  const slices = data.donut.map((d) => ({ label: categoryLabel(d.label), value: d.amount, color: colors[d.key] }));
  const top = data.rows[0];
  const max = data.rows.reduce((m, r) => (r.amount > m ? r.amount : m), 0n);
  const listed = data.rows.filter((r) => r.amount > 0n).slice(0, 14);
  const phone = useIsPhone();
  return (
    <div className="space-y-4">
      <div className="card p-4 lg:p-6">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-10">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-ink-3">Total Spending</div>
            <div className="display num text-[28px] leading-tight text-ink">{formatMilli(data.total)}</div>
            <div className="text-[13px] text-ink-3">{data.period.label}</div>
            <Chart summary={`Spending by ${data.params.level} totaling ${formatMilli(data.total)}`} height={phone ? 230 : 300} className="mt-4">
              {slices.length ? <DonutChart data={slices} centerLabel="Spent" centerValue={data.total} /> : EMPTY}
            </Chart>
          </div>
          <ol aria-label={data.params.level === "group" ? "Groups" : "Categories"} className="min-w-0 self-start">
            {listed.map((r) => {
              const w = max > 0n ? Number((r.amount * 1000n) / max) / 10 : 0;
              const body = (
                <>
                  <span className="flex min-w-0 items-center gap-2">
                    {data.params.level === "category" && r.key !== "other" ? <CategoryIcon icon={icons[r.key]} name={r.label} size={16} /> : <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colors[r.key] }} />}
                    <span className="truncate text-[14px] text-ink">{categoryLabel(r.label)}</span>
                  </span>
                  <span className="num text-right text-[12.5px] text-ink-3">{bpsLabel(r.shareBps)}</span>
                  <span className="num text-right text-[14px] font-semibold text-ink">{money(r.amount)}</span>
                  <span className="col-span-3 h-1.5 overflow-hidden rounded-full bg-track">
                    <span className="block h-full rounded-full" style={{ width: `${w}%`, background: colors[r.key] === "transparent" ? "var(--chart-axis)" : colors[r.key] }} />
                  </span>
                </>
              );
              const cls = "grid grid-cols-[minmax(0,1fr)_56px_92px] items-center gap-x-3 gap-y-1.5 rounded-lg px-2 py-2";
              return (
                <li key={r.key}>
                  {hrefs[r.key] ? (
                    <a href={hrefs[r.key]} className={cx(cls, "hover:bg-accent-soft")}>
                      {body}
                    </a>
                  ) : (
                    <div className={cls}>{body}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      <Stats
        items={[
          { label: "Monthly average", value: money(data.avgMonthly), note: `${data.period.months.length} ${data.period.months.length === 1 ? "month" : "months"}` },
          { label: "Daily average", value: formatMilli(data.avgDaily), note: `${data.period.days} days` },
          {
            label: "Largest outflow",
            value: data.largestOutflow ? money(data.largestOutflow.amount) : "—",
            note: data.largestOutflow ? `${data.largestOutflow.payee ?? "No payee"} · ${dayLabel(data.largestOutflow.date, false)}` : undefined,
          },
          { label: "Most frequent", value: data.mostFrequent ? categoryLabel(data.mostFrequent.label) : "—", note: data.mostFrequent ? `${data.mostFrequent.outflows} outflows` : undefined },
        ]}
      />
      {top && (
        <p className="text-[14px] text-ink-2">
          Biggest share: <span className="font-semibold text-ink">{categoryLabel(top.label)}</span> at <span className="num font-semibold text-ink">{bpsLabel(top.shareBps)}</span> of spending.
        </p>
      )}
    </div>
  );
}

// ── 2. spending trends ──────────────────────────────────────────────────────

export function SpendingTrendsView({ data }: { data: SpendingTrends }) {
  const phone = useIsPhone();
  const series = data.series.map((s, i) => ({ key: `s${i}`, label: s.label, color: s.key === "other" ? "var(--chart-axis)" : `var(--chart-${(i % 8) + 1})` }));
  const rows = data.months.map((m) => ({ month: m.month, ...Object.fromEntries(data.series.map((s, i) => [`s${i}`, m.values[s.key] ?? 0n])) }));
  const last = data.months[data.months.length - 1];
  return (
    <div className="space-y-6">
      <Stats
        items={[
          { label: "Total", value: money(data.total), note: data.period.label },
          { label: "Monthly average", value: money(data.average) },
          { label: "Largest", value: data.series[0] ? money(data.series[0].avgMonthly) : "—", note: data.series[0] ? `${data.series[0].label} / month` : undefined },
          { label: last ? monthLabel(last.month) : "Latest", value: last ? money(last.total) : "—", note: last ? (last.total > data.average ? "above average" : "below average") : undefined },
        ]}
      />
      <Chart summary={`Monthly spending by ${data.params.level}, stacked, with the average`} height={phone ? 260 : 340}>
        <StackedBarChart data={rows} xKey="month" series={series} showAverage />
      </Chart>
      <Legend items={series.map((s) => s.label)} colors={series.map((s) => s.color)} />
    </div>
  );
}

/** Square-swatch legend for stacked charts. */
function Legend({ items, colors }: { items: string[]; colors?: string[] }) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-ink-2">
      {items.map((l, i) => (
        <li key={l} className="flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5" style={{ background: colors?.[i] ?? `var(--chart-${(i % 8) + 1})` }} />
          {l}
        </li>
      ))}
    </ul>
  );
}

// ── 3. income vs expense ────────────────────────────────────────────────────

export function IncomeVsExpenseView({ data }: { data: IncomeVsExpense }) {
  const phone = useIsPhone();
  const t = data.totals;
  return (
    <div className="space-y-6">
      <Stats
        items={[
          { label: "Income", value: money(t.income), note: `avg ${money(data.avgIncome)} / month` },
          { label: "Expense", value: money(t.expense), note: `avg ${money(data.avgExpense)} / month` },
          { label: "Net", value: <Money value={t.net} tone="signed" cents={false} />, note: data.period.label },
          { label: "Savings rate", value: t.savingsRateBps === null ? "—" : bpsLabel(t.savingsRateBps), note: "of income kept" },
        ]}
      />
      <Chart summary="Monthly income and expense bars with a net line" height={phone ? 260 : 320}>
        <ComboChart
          data={data.months.map((m) => ({ month: m.month, income: m.income, expense: m.expense, net: m.net }))}
          xKey="month"
          bars={[
            { key: "income", label: "Income", color: "var(--pos-bar)" },
            { key: "expense", label: "Expense", color: "var(--chart-axis)" },
          ]}
          lines={[{ key: "net", label: "Net" }]}
        />
      </Chart>
      <Legend items={["Income", "Expense", "Net"]} colors={["var(--pos-bar)", "var(--chart-axis)", "var(--ink)"]} />
    </div>
  );
}

// ── 4. net worth ────────────────────────────────────────────────────────────

export function NetWorthView({ data }: { data: NetWorthReport }) {
  const phone = useIsPhone();
  const xFormat = data.granularity === "month" ? (d: string) => fmtMonthTick(`${d.slice(0, 7)}-01`) : (d: string) => dayLabel(d, false);
  return (
    <div className="space-y-6">
      <Stats
        items={[
          { label: "Net worth", value: money(data.end.netWorth), note: `as of ${dayLabel(data.end.date)}` },
          {
            label: "Change",
            value: <Money value={data.change} tone="signed" sign="always" cents={false} />,
            note: data.changeBps === null ? data.period.label : `${data.changeBps >= 0 ? "+" : ""}${bpsLabel(data.changeBps)} · ${data.period.label}`,
          },
          { label: "Assets", value: money(data.end.assets) },
          { label: "Liabilities", value: money(-data.end.liabilities) },
        ]}
      />
      <Chart summary="Assets above zero, liabilities below, with net worth as a line" height={phone ? 260 : 340}>
        <AreaChart
          data={data.points.map((p) => ({ date: p.date, assets: p.assets, liabilities: p.liabilities, net: p.netWorth }))}
          xKey="date"
          xFormat={xFormat}
          stacked={false}
          series={[
            { key: "assets", label: "Assets", color: "var(--chart-1)" },
            { key: "liabilities", label: "Liabilities", color: "var(--neg-bar)" },
          ]}
          line={{ key: "net", label: "Net worth" }}
        />
      </Chart>
      <Legend items={["Assets", "Liabilities", "Net worth"]} colors={["var(--chart-1)", "var(--neg-bar)", "var(--ink)"]} />
    </div>
  );
}

// ── 5. age of money ─────────────────────────────────────────────────────────

export function AgeOfMoneyView({ data }: { data: AgeOfMoneyReport }) {
  const phone = useIsPhone();
  return (
    <div className="space-y-6">
      <Stats
        items={[
          { label: "Age of Money", value: data.current === null ? "—" : `${data.current} days`, note: "latest month" },
          { label: "Change", value: data.change === null ? "—" : `${data.change > 0 ? "+" : ""}${data.change} days`, note: data.period.label },
          { label: "Highest", value: data.max ? `${data.max.days} days` : "—", note: data.max ? monthLabel(data.max.month) : undefined },
          { label: "Lowest", value: data.min ? `${data.min.days} days` : "—", note: data.min ? monthLabel(data.min.month) : undefined },
        ]}
      />
      <Chart summary="Age of Money in days at each month end" height={phone ? 240 : 300}>
        <ComboChart data={data.months.map((m) => ({ month: m.month, days: m.days }))} xKey="month" bars={[]} lines={[{ key: "days", label: "Age of Money", color: "var(--chart-1)" }]} valueFormat={days} />
      </Chart>
      <p className="max-w-[60ch] text-[13px] text-ink-3">
        The average age, in days, of the money spent in the last ten cash outflows at each month end. Card spending counts when the card is paid.
      </p>
    </div>
  );
}

// ── 6. category detail ──────────────────────────────────────────────────────

export function CategoryDetailView({ data }: { data: CategoryDetailReport }) {
  const phone = useIsPhone();
  if (!data.subject) return EMPTY;
  return (
    <div className="space-y-6">
      <Stats
        items={[
          { label: "Avg assigned", value: money(data.avgAssigned), note: "per month" },
          { label: "Avg spent", value: money(data.avgSpent), note: "per month" },
          { label: "Total spent", value: money(data.totalSpent), note: data.period.label },
          { label: "Target met", value: data.monthsWithTarget ? `${data.monthsMetTarget} of ${data.monthsWithTarget}` : "No target", note: data.monthsWithTarget ? "months" : undefined },
        ]}
      />
      <Chart summary={`Assigned against spent per month for ${data.subject.name}`} height={phone ? 240 : 300}>
        <ComboChart
          data={data.months.map((m) => ({ month: m.month, assigned: m.assigned, spent: m.spent }))}
          xKey="month"
          bars={[
            { key: "assigned", label: "Assigned", color: "var(--chart-1)" },
            { key: "spent", label: "Spent", color: "var(--chart-2)" },
          ]}
          average={{ value: data.avgSpent, label: `avg spent ${fmtCompact(Number(data.avgSpent) / 1000)}` }}
        />
      </Chart>
      <Legend items={["Assigned", "Spent"]} />
    </div>
  );
}

// ── 7. payees ───────────────────────────────────────────────────────────────

export function PayeesView({ data, hrefs }: { data: PayeesReport; hrefs: Record<string, string> }) {
  const [by, setBy] = useState<"spend" | "count">("spend");
  const phone = useIsPhone();
  const rows = (by === "spend" ? data.bySpend : data.byFrequency).slice(0, 10);
  const items = rows.map((p) => ({
    key: p.key,
    label: p.name,
    value: by === "spend" ? p.amount : p.transactions,
    valueLabel: by === "spend" ? money(p.amount) : `${p.transactions}×`,
    note: by === "spend" ? `${p.transactions}×` : money(p.amount),
    href: hrefs[p.key],
  }));
  const series = data.trend.series.map((s, i) => ({ key: `p${i}`, label: s.label }));
  return (
    <div className="space-y-6">
      <Stats
        items={[
          { label: "Spent", value: money(data.total), note: data.period.label },
          { label: "Payees", value: data.payeeCount.toLocaleString("en-US") },
          { label: "Top by spend", value: data.bySpend[0] ? money(data.bySpend[0].amount) : "—", note: data.bySpend[0]?.name },
          { label: "Most often", value: data.byFrequency[0] ? `${data.byFrequency[0].transactions}×` : "—", note: data.byFrequency[0]?.name },
        ]}
      />
      <div data-report-chart>
        <ChartFrame
          title={by === "spend" ? "Top payees by spend" : "Top payees by frequency"}
          summary="Top ten payees as ranked bars"
          height={rankBarsHeight(items.length)}
          actions={
            <SegmentedControl<"spend" | "count">
              label="Rank by"
              size="sm"
              value={by}
              onChange={setBy}
              options={[
                { value: "spend", label: "Spend" },
                { value: "count", label: "Frequency" },
              ]}
            />
          }
        >
          <RankBars items={items} />
        </ChartFrame>
      </div>
      {series.length > 0 && data.trend.months.length > 1 && (
        <>
          <ChartFrame title="Trend" subtitle="Monthly spending, top five payees" summary="Monthly spending of the top five payees" height={phone ? 220 : 260}>
            <LineChart data={data.trend.months.map((m) => ({ month: m.month, ...Object.fromEntries(data.trend.series.map((s, i) => [`p${i}`, m.values[s.key] ?? 0n])) }))} xKey="month" series={series} />
          </ChartFrame>
          <Legend items={series.map((s) => s.label)} />
        </>
      )}
    </div>
  );
}

// ── 8. cash flow ────────────────────────────────────────────────────────────

export function CashFlowView({ data }: { data: CashFlowSankey }) {
  const phone = useIsPhone();
  // Phones: sources → income → groups only (category labels don't fit); the table lists categories.
  const cats = new Set(data.nodes.filter((n) => n.kind === "category").map((n) => n.name));
  const nodes = phone ? data.nodes.filter((n) => !cats.has(n.name)) : data.nodes;
  const links = phone ? data.links.filter((l) => !cats.has(l.target)) : data.links;
  const leaves = nodes.filter((n) => n.kind === "category" || n.kind === "group").length;
  const height = phone ? Math.max(320, leaves * 44) : Math.max(380, Math.min(900, leaves * 24 + 40));
  return (
    <div className="space-y-6">
      <Stats
        items={[
          { label: "Income", value: money(data.income), note: data.period.label },
          { label: "Spending", value: money(data.spending) },
          { label: data.shortfall > 0n ? "From earlier months" : "Kept", value: money(data.shortfall > 0n ? data.shortfall : data.saved), note: data.shortfall > 0n ? "spending above income" : "income not spent" },
          { label: "Groups", value: String(data.nodes.filter((n) => n.kind === "group").length) },
        ]}
      />
      <Chart summary="Sankey diagram: income sources into income, out to groups and categories" height={height}>
        {links.length ? <SankeyChart nodes={nodes.map((n) => n.name)} links={links} /> : EMPTY}
      </Chart>
    </div>
  );
}

// ── 9. investment growth ────────────────────────────────────────────────────

export function InvestmentGrowthView({ data }: { data: InvestmentGrowthReport }) {
  const phone = useIsPhone();
  const t = data.totals;
  return (
    <div className="space-y-6">
      <Stats
        items={[
          { label: "Balance", value: money(t.end), note: data.accounts.length === 1 ? data.accounts[0]!.name : `${data.accounts.length} accounts` },
          { label: "Contributions", value: money(t.contributions), note: data.period.label },
          { label: "Market change", value: <Money value={t.marketChange} tone="signed" sign="always" cents={false} />, note: data.contributionsKnown ? undefined : "includes unknown contributions" },
          { label: "Total change", value: <Money value={t.change} tone="signed" sign="always" cents={false} /> },
        ]}
      />
      <Chart summary="Monthly contributions and market change, stacked" height={phone ? 260 : 320}>
        <ComboChart
          data={data.months.map((m) => ({ month: m.month, contributions: m.contributions, market: m.marketChange, change: m.change }))}
          xKey="month"
          stacked
          bars={[
            { key: "contributions", label: "Contributions", color: "var(--chart-1)" },
            { key: "market", label: "Market change", color: "var(--chart-3)" },
          ]}
          lines={[{ key: "change", label: "Total change", dashed: true }]}
        />
      </Chart>
      <Legend items={["Contributions", "Market change", "Total change"]} colors={["var(--chart-1)", "var(--chart-3)", "var(--ink)"]} />
      {data.accounts.length > 1 && (
        <section aria-label="By account">
          <h2 className="eyebrow mb-2">By account</h2>
          <ul className="divide-y divide-rule border-y border-rule">
            {data.accounts.map((a) => (
              <li key={a.accountId} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-0.5 py-2.5 text-[14px] lg:grid-cols-[minmax(0,1fr)_140px_140px_140px]">
                <span className="truncate text-ink">{a.name}</span>
                <span className="num text-right text-ink">{formatMilli(a.end)}</span>
                <span className="num text-[12px] text-ink-3 lg:text-right lg:text-[14px] lg:text-ink-2">
                  <span className="lg:hidden">contributed </span>
                  {money(a.totals.contributions)}
                </span>
                <span className="text-right text-[12px] lg:text-[14px]">
                  <Money value={a.totals.marketChange} tone="signed" sign="always" cents={false} />
                  <span className="text-ink-3 lg:hidden"> market</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-1 hidden grid-cols-[minmax(0,1fr)_140px_140px_140px] gap-x-4 text-right lg:grid">
            <span />
            <span className="eyebrow">Balance</span>
            <span className="eyebrow">Contributed</span>
            <span className="eyebrow">Market</span>
          </div>
        </section>
      )}
    </div>
  );
}

// ── 10. budget performance ──────────────────────────────────────────────────

export function BudgetPerformanceView({ data, hrefs }: { data: BudgetPerformanceReport; hrefs: Record<string, string> }) {
  const ranked = data.rows.filter((r) => r.monthsOverAssigned > 0 || r.monthsOverspent > 0).slice(0, 12);
  const worst = data.rows[0];
  return (
    <div className="space-y-6">
      <Stats
        items={[
          { label: "Months", value: String(data.months.length), note: data.months.length ? `${monthLabel(data.months[0]!)} – ${monthLabel(data.months[data.months.length - 1]!)}` : undefined },
          { label: "Overspent", value: String(data.totals.overspentCategoryMonths), note: "category-months in the red" },
          { label: "Avg assigned", value: money(data.totals.avgAssigned), note: "per month" },
          { label: "Suggested", value: money(data.totals.suggested), note: "per month, from avg spending" },
        ]}
      />
      <div data-report-chart>
        <ChartFrame
          title="Spending past the plan"
          subtitle="Share of months where spending ran past that month’s assignment"
          summary="Categories ranked by the share of months spending exceeded the assignment"
          height={rankBarsHeight(ranked.length)}
        >
          {ranked.length ? (
            <RankBars
              max={10_000}
              items={ranked.map((r) => ({
                key: r.key,
                label: r.label,
                value: r.overAssignedBps,
                valueLabel: `${r.monthsOverAssigned} of ${r.months}`,
                note: r.avgOverAssigned > 0n ? `avg ${money(r.avgOverAssigned)} over` : undefined,
                href: hrefs[r.key],
                color: r.monthsOverspent > 0 ? "var(--neg-bar)" : "var(--warn-bar)",
              }))}
            />
          ) : (
            EMPTY
          )}
        </ChartFrame>
      </div>
      {worst && worst.monthsOverspent === 0 && <p className="text-[14px] text-ink-2">No category ended a month overspent in this period: every overspend was covered.</p>}
    </div>
  );
}

// ── 11. subscriptions ───────────────────────────────────────────────────────

export function SubscriptionsView({ data, hrefs }: { data: SubscriptionsReport; hrefs: Record<string, string> }) {
  const active = data.active;
  return (
    <div className="space-y-6">
      <Stats
        items={[
          { label: "Per year", value: money(data.totals.annualized), note: `${data.totals.count} active` },
          { label: "Per month", value: money(data.totals.monthly) },
          { label: "Price increases", value: String(data.priceIncreases.length), note: `since ${dayLabel(data.period.from)}` },
          { label: "New", value: String(data.newSubscriptions.length), note: "first seen this period" },
        ]}
      />
      <div data-report-chart>
        <ChartFrame title="What they cost a year" summary="Active subscriptions ranked by annual cost" height={rankBarsHeight(active.length)}>
          {active.length ? (
            <RankBars
              items={active.map((s) => ({
                key: s.key,
                label: s.payee,
                value: s.annualized,
                valueLabel: money(s.annualized),
                note: `${formatMilli(s.amount)} / ${s.cadence === "monthly" ? "mo" : s.cadence === "weekly" ? "wk" : "yr"}`,
                href: hrefs[s.key],
                color: s.priceChange && s.priceChange.changeBps > 0 ? "var(--warn-bar)" : undefined,
              }))}
            />
          ) : (
            EMPTY
          )}
        </ChartFrame>
      </div>
      {data.priceIncreases.length > 0 && (
        <section aria-label="Price changes">
          <h2 className="eyebrow mb-2">Price changes</h2>
          <ul className="divide-y divide-rule border-y border-rule">
            {data.priceIncreases.map((s) => (
              <li key={s.key} className="flex flex-col gap-0.5 py-2.5 text-[14px] sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                <span className="min-w-0 truncate">
                  <span className="text-ink">{s.payee}</span> <span className="text-ink-3">since {dayLabel(s.priceChange!.changedOn, false)}</span>
                </span>
                <span className="num shrink-0 text-ink-2">
                  {formatMilli(s.priceChange!.from)} → <span className="text-warn">{formatMilli(s.priceChange!.to)}</span>
                  <span className="ml-2 text-ink-3">+{bpsLabel(s.priceChange!.changeBps)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
