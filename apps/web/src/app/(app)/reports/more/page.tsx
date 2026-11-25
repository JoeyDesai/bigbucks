import Link from "next/link";
import { ArrowUpRight, Pin } from "lucide-react";
import { REPORTS, ensureFresh, reportParams, runReport, savedReportsIndex, type ReportMeta, type SavedReportItem, type SpendingBreakdown } from "@homebase/core";
import { formatMilli, today as localToday } from "@homebase/shared";
import { SpendingBreakdownMini } from "@/components/reports/SpendingBreakdownMini";
import { PageHeader } from "@/components/shell/PageHeader";
import { ReflectTabs } from "@/components/reports/ReflectTabs";
import { requireUser } from "@/server/auth";
import { getDb } from "@/server/db";

export const metadata = { title: "Reflect · More reports" };

const money = (m: bigint) => formatMilli(m, { cents: false });

/** One headline figure per report for the index (all cheap: the engine result is memoized). */
async function headlines(today: string): Promise<{ figures: Partial<Record<string, { value: string; note: string }>>; month: SpendingBreakdown }> {
  const db = getDb();
  // Bring the engine cache up to date once, so the parallel reports below don't all recompute it at the same time.
  await ensureFresh(db, today);
  const p = reportParams({ today, period: "last12" });
  const m = reportParams({ today, period: "month" });
  const [month, trends, ie, nw, aom, payees, subs, inv, perf] = await Promise.all([
    runReport(db, "spending-breakdown", m),
    runReport(db, "spending-trends", { ...p, level: "group" }),
    runReport(db, "income-vs-expense", p),
    runReport(db, "net-worth", p),
    runReport(db, "age-of-money", p),
    runReport(db, "payees", p),
    runReport(db, "subscriptions", p),
    runReport(db, "investment-growth", p),
    runReport(db, "budget-performance", p),
  ]);
  const overPlan = perf.rows.filter((r) => r.overAssignedBps >= 5000).length;
  return {
    month,
    figures: {
      "spending-breakdown": { value: money(month.total), note: month.period.label },
      "spending-trends": { value: money(trends.average), note: "monthly average" },
      "income-vs-expense": { value: ie.totals.savingsRateBps === null ? "—" : `${(ie.totals.savingsRateBps / 100).toFixed(1)}%`, note: "saved, last 12 months" },
      "net-worth": { value: money(nw.end.netWorth), note: `${nw.change >= 0n ? "+" : "−"}${money(nw.change < 0n ? -nw.change : nw.change)} in 12 months` },
      "age-of-money": { value: aom.current === null ? "—" : `${aom.current} days`, note: "this month" },
      payees: { value: payees.bySpend[0]?.name ?? "—", note: payees.bySpend[0] ? `${money(payees.bySpend[0].amount)} in 12 months` : "" },
      "cash-flow": { value: money(ie.totals.income), note: "in, last 12 months" },
      "investment-growth": { value: `${inv.totals.marketChange >= 0n ? "+" : "−"}${money(inv.totals.marketChange < 0n ? -inv.totals.marketChange : inv.totals.marketChange)}`, note: "market, 12 months" },
      "budget-performance": { value: String(overPlan), note: overPlan === 1 ? "category often over plan" : "categories often over plan" },
      subscriptions: { value: money(subs.totals.annualized), note: `${subs.totals.count} subscriptions a year` },
    },
  };
}

function Row({ href, title, blurb, figure, pinned }: { index?: string; href: string; title: string; blurb: string; figure?: { value: string; note: string }; pinned?: boolean }) {
  return (
    <li>
      <Link href={href} className="card group flex min-h-[72px] items-center gap-4 px-4 py-3 transition-colors hover:border-accent">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[16px] font-bold leading-snug text-ink group-hover:text-accent">
            {pinned && <Pin size={13} strokeWidth={2} aria-label="Pinned" />}
            {title}
          </span>
          <span className="mt-0.5 block text-[13px] text-ink-3">{blurb}</span>
        </span>
        {figure && (
          <span className="max-w-[9rem] text-right sm:max-w-none">
            <span className="num block truncate whitespace-nowrap text-[15px] font-semibold text-ink">{figure.value}</span>
            <span className="hidden whitespace-nowrap text-[12px] text-ink-3 sm:block">{figure.note}</span>
          </span>
        )}
        <ArrowUpRight size={17} strokeWidth={2} aria-hidden className="text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
      </Link>
    </li>
  );
}

function savedBlurb(r: SavedReportItem): string {
  if (r.kind === "report") return `${REPORTS.find((x) => x.slug === r.report)?.title ?? "Report"} · saved view`;
  if (r.kind === "chart") return "Chart from Ask";
  if (r.kind === "query") return "Live query";
  return "Can’t be shown";
}

export default async function ReportsPage() {
  await requireUser();
  const today = localToday();
  const [saved, h] = await Promise.all([savedReportsIndex(getDb()), headlines(today)]);
  const pinned = saved.filter((s) => s.pinned);
  const builtIn: ReportMeta[] = REPORTS.filter((r) => r.slug !== "saved");
  const savedMeta = REPORTS.find((r) => r.slug === "saved")!;
  return (
    <>
      <PageHeader title="Reflect" className="lg:pb-2" />
      <ReflectTabs active="more" />
      <div className="grid gap-8 bg-paper-sunken px-4 pb-16 pt-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:px-6">
        <div className="min-w-0 space-y-10">
          {pinned.length > 0 && (
            <nav aria-label="Pinned reports">
              <h2 className="mb-2 text-[13px] font-bold uppercase tracking-[0.05em] text-ink-3">Pinned</h2>
              <ol className="space-y-2">
                {pinned.map((r) => (
                  <Row key={r.id} index="" pinned href={`/reports/saved/${r.id}`} title={r.name} blurb={savedBlurb(r)} />
                ))}
              </ol>
            </nav>
          )}
          <nav aria-label="Reports">
            <h2 className="mb-2 text-[13px] font-bold uppercase tracking-[0.05em] text-ink-3">All reports</h2>
            <ol className="space-y-2">
              {builtIn.map((r, i) => (
                <Row key={r.slug} index={String(i + 1).padStart(2, "0")} href={`/reports/${r.slug}`} title={r.title} blurb={r.blurb} figure={h.figures[r.slug]} />
              ))}
              <Row
                index={String(builtIn.length + 1).padStart(2, "0")}
                href="/reports/saved"
                title={savedMeta.title}
                blurb={savedMeta.blurb}
                figure={{ value: String(saved.length), note: saved.length === 1 ? "saved report" : "saved reports" }}
              />
            </ol>
          </nav>
        </div>
        <aside aria-label="This month" className="card h-fit min-w-0 p-4">
          <SpendingBreakdownMini data={h.month} />
        </aside>
      </div>
    </>
  );
}
