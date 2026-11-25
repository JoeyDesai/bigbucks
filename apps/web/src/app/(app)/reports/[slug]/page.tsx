import Link from "next/link";
import { notFound } from "next/navigation";
import { ChartColumn, ChevronLeft } from "lucide-react";
import { NotFoundError, ValidationError, isRunnableReport, listCategories, paramsFromSearch, paramsToSearch, reportDefaults, reportMeta, runReport, scopedAccounts, type ReportResultMap, type RunnableReport } from "@homebase/core";
import { monthOf, today as localToday } from "@homebase/shared";
import { sliceColors, trendColors } from "@/components/reports/colors";
import { ReportActions } from "@/components/reports/ReportActions";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { ReportTableView } from "@/components/reports/ReportTableView";
import {
  AgeOfMoneyView,
  BudgetPerformanceView,
  CashFlowView,
  CategoryDetailView,
  IncomeVsExpenseView,
  InvestmentGrowthView,
  NetWorthView,
  PayeesView,
  SpendingBreakdownView,
  SpendingTrendsView,
  SubscriptionsView,
} from "@/components/reports/ReportViews";
import { PageHeader } from "@/components/shell/PageHeader";
import { ReflectTabs, isMainReflectTab } from "@/components/reports/ReflectTabs";
import { EmptyState } from "@/components/ui/EmptyState";
import { requireUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { ENTITY_LABEL, filterAccounts, tableHrefs, urlParams } from "../data";

type Search = Record<string, string | string[] | undefined>;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  await requireUser();
  const { slug } = await params;
  return { title: reportMeta(slug)?.title ?? "Report" };
}

const TABLE_TITLE: Partial<Record<RunnableReport, string>> = {
  "spending-breakdown": "Ranked",
  "spending-trends": "By category",
  "income-vs-expense": "By month",
  "net-worth": "By account",
  "age-of-money": "By month",
  "category-detail": "By month",
  payees: "All payees",
  "cash-flow": "Flows",
  "investment-growth": "By month",
  "budget-performance": "Every category",
  subscriptions: "Every recurring charge",
};

export default async function ReportPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Search> }) {
  // Every page checks the session itself: a client navigation renders only the segments below the layout.
  await requireUser();
  const { slug } = await params;
  const meta = reportMeta(slug);
  if (!meta || !isRunnableReport(slug)) notFound();
  const sp = await searchParams;
  const db = getDb();
  const today = localToday();
  const defaults = reportDefaults(slug);
  const p = paramsFromSearch(sp, { ...defaults, today });

  let data: ReportResultMap[RunnableReport];
  try {
    data = await runReport(db, slug, p);
  } catch (e) {
    if (e instanceof ValidationError || e instanceof NotFoundError) {
      return (
        <Shell slug={slug} title={meta.title}>
          <EmptyState icon={<ChartColumn size={28} strokeWidth={1.25} />} title="Can’t show that">
            {e.message}. <Link href={`/reports/${slug}`} className="underline underline-offset-4">Reset the filters</Link>.
          </EmptyState>
        </Shell>
      );
    }
    throw e;
  }

  const hrefs = tableHrefs(slug, data.table, data.period, p);
  const accountKind = slug === "net-worth" || slug === "investment-growth" ? "all" : "budget";
  const accounts = meta.filters.accounts && slug !== "investment-growth" ? await filterAccounts(db, p, accountKind) : [];
  const investmentAccounts =
    slug === "investment-growth" ? (await scopedAccounts(db, { ...p, accountIds: undefined })).filter((a) => ["brokerage", "retirement", "hsa", "crypto"].includes(a.kind)).map((a) => ({ id: a.id, name: a.name })) : undefined;
  const search = paramsToSearch({ ...p, today: undefined }, defaults).toString();
  const q = search ? `?${search}` : "";
  const subject = slug === "category-detail" ? (data as ReportResultMap["category-detail"]).subject?.name : undefined;
  const subtitle = [subject, data.period.label, meta.filters.entity ? ENTITY_LABEL[p.entity] : null, meta.filters.level ? (p.level === "group" ? "by group" : "by category") : null].filter(Boolean).join(" · ");

  const icons: Record<string, string | null> =
    slug === "spending-breakdown" ? Object.fromEntries((await listCategories(db)).flatMap((g) => g.categories.map((c) => [c.id, (c as { icon?: string | null }).icon ?? null]))) : {};
  const view = (() => {
    switch (slug) {
      case "spending-breakdown":
        return <SpendingBreakdownView data={data as ReportResultMap[typeof slug]} hrefs={hrefs} icons={icons} />;
      case "spending-trends":
        return <SpendingTrendsView data={data as ReportResultMap[typeof slug]} />;
      case "income-vs-expense":
        return <IncomeVsExpenseView data={data as ReportResultMap[typeof slug]} />;
      case "net-worth":
        return <NetWorthView data={data as ReportResultMap[typeof slug]} />;
      case "age-of-money":
        return <AgeOfMoneyView data={data as ReportResultMap[typeof slug]} />;
      case "category-detail":
        return <CategoryDetailView data={data as ReportResultMap[typeof slug]} />;
      case "payees":
        return <PayeesView data={data as ReportResultMap[typeof slug]} hrefs={hrefs} />;
      case "cash-flow":
        return <CashFlowView data={data as ReportResultMap[typeof slug]} />;
      case "investment-growth":
        return <InvestmentGrowthView data={data as ReportResultMap[typeof slug]} />;
      case "budget-performance":
        return <BudgetPerformanceView data={data as ReportResultMap[typeof slug]} hrefs={hrefs} />;
      case "subscriptions":
        return <SubscriptionsView data={data as ReportResultMap[typeof slug]} hrefs={hrefs} />;
    }
  })();
  const detail = slug === "category-detail" ? (data as ReportResultMap["category-detail"]) : null;
  const swatches =
    slug === "spending-breakdown" ? sliceColors(data as ReportResultMap["spending-breakdown"]) : slug === "spending-trends" ? trendColors(data as ReportResultMap["spending-trends"]) : undefined;
  const tableTitle = slug === "spending-trends" || slug === "spending-breakdown" ? (p.level === "group" ? "By group" : "By category") : TABLE_TITLE[slug];

  return (
    <Shell slug={slug} title={meta.title} eyebrow={subtitle}>
      <ReportFilters
        key={q}
        slug={slug}
        params={urlParams(p)}
        defaults={defaults}
        period={{ label: data.period.label, from: data.period.from, to: data.period.to, anchor: data.period.anchor }}
        currentMonth={monthOf(today)}
        show={{ ...meta.filters, accounts: meta.filters.accounts && accounts.length > 0 }}
        accounts={accounts}
        subjectOptions={detail?.options}
        subjectId={detail?.subject?.id ?? null}
        investmentAccounts={investmentAccounts}
      >
        <div className="mt-6 space-y-10">
          {view}
          <section aria-labelledby="report-table">
            <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
              <h2 id="report-table" className="text-[17px] font-bold leading-tight text-ink">
                {tableTitle}
              </h2>
              <ReportActions slug={slug} search={q} title={meta.title} subtitle={subtitle} />
            </div>
            <ReportTableView table={data.table} hrefs={hrefs} swatches={swatches} caption={`${meta.title}, ${data.period.label}`} />
            {Object.keys(hrefs).length > 0 && <p className="mt-2 text-[12px] text-ink-3">Select a row to see its transactions.</p>}
          </section>
        </div>
      </ReportFilters>
    </Shell>
  );
}

function Shell({ slug, title, eyebrow, children }: { slug: string; title: string; eyebrow?: string; children: React.ReactNode }) {
  const main = isMainReflectTab(slug);
  return (
    <>
      <PageHeader title="Reflect" className="lg:pb-2" />
      <ReflectTabs active={slug} />
      <div className="min-h-[calc(100dvh-120px)] bg-paper-sunken px-4 pb-16 pt-4 lg:px-6">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {!main && (
            <Link href="/reports/more" className="inline-flex items-center gap-0.5 text-[14px] font-semibold text-accent">
              <ChevronLeft size={16} strokeWidth={2.2} aria-hidden /> More reports
            </Link>
          )}
          <h2 className={main ? "sr-only" : "text-[19px] font-bold text-ink"}>{title}</h2>
          {eyebrow && <p className="text-[13px] text-ink-3">{eyebrow}</p>}
        </div>
        <div className="lg:max-w-[1180px]">{children}</div>
      </div>
    </>
  );
}
