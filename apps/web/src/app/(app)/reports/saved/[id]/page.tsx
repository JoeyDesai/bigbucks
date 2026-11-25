import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft, Download, TriangleAlert } from "lucide-react";
import { NotFoundError, paramsToSearch, reportDefaults, runSavedReport } from "@homebase/core";
import { ChartSpecView } from "@/components/reports/ChartSpecView";
import { PinButton } from "@/components/reports/PinButton";
import { PageHeader } from "@/components/shell/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { requireUser } from "@/server/auth";
import { getDb } from "@/server/db";

export default async function SavedReportPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let r;
  try {
    r = await runSavedReport(getDb(), id);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  if (r.parsed.kind === "report") {
    const q = paramsToSearch(r.parsed.params, reportDefaults(r.parsed.report)).toString();
    redirect(`/reports/${r.parsed.report}${q ? `?${q}` : ""}`);
  }
  return (
    <>
      <div className="px-2 pt-2 lg:px-6 lg:pt-6">
        <Link href="/reports/saved" className="inline-flex min-h-11 items-center gap-1 px-2 text-[14px] font-semibold text-accent hover:text-accent-hover">
          <ChevronLeft size={16} strokeWidth={1.75} aria-hidden /> Saved reports
        </Link>
      </div>
      <PageHeader title={r.saved.name} eyebrow={r.parsed.kind === "query" ? "Saved report · live" : "Saved report"} className="lg:pt-2" actions={<PinButton id={r.saved.id} pinned={r.saved.pinned} name={r.saved.name} />} />
      <div className="px-4 pb-16 pt-2 lg:max-w-[1040px] lg:px-8">
        {r.chart ? (
          <div className="space-y-4">
            {r.chart.title !== r.saved.name && <h2 className="display text-[20px] text-ink">{r.chart.title}</h2>}
            <ChartSpecView spec={r.chart} />
            <a href={`/reports/saved/${r.saved.id}/export`} className="inline-flex min-h-9 items-center gap-1.5 rounded-sm px-2 text-[13px] font-medium text-ink-2 hover:bg-paper-sunken hover:text-ink">
              <Download size={15} strokeWidth={1.75} aria-hidden /> CSV
            </a>
          </div>
        ) : (
          <EmptyState icon={<TriangleAlert size={28} strokeWidth={1.25} />} title="This report can’t be shown">
            {r.parsed.kind === "invalid" ? r.parsed.error : "Unknown format."}
          </EmptyState>
        )}
      </div>
    </>
  );
}
