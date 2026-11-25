import Link from "next/link";
import { ChevronLeft, Bookmark } from "lucide-react";
import { reportMeta, savedReportsIndex } from "@homebase/core";
import { PinButton } from "@/components/reports/PinButton";
import { PageHeader } from "@/components/shell/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { requireUser } from "@/server/auth";
import { getDb } from "@/server/db";

export const metadata = { title: "Saved reports" };

const KIND: Record<string, string> = { pie: "Donut", bar: "Bars", stacked_bar: "Stacked bars", line: "Line", area: "Area", sankey: "Flow", table: "Table" };

export default async function SavedReportsPage() {
  await requireUser();
  const items = await savedReportsIndex(getDb());
  return (
    <>
      <div className="px-2 pt-2 lg:px-6 lg:pt-6">
        <Link href="/reports/more" className="inline-flex min-h-11 items-center gap-1 px-2 text-[14px] font-semibold text-accent hover:text-accent-hover">
          <ChevronLeft size={16} strokeWidth={1.75} aria-hidden /> More reports
        </Link>
      </div>
      <PageHeader title="Saved reports" className="lg:pt-2" />
      <div className="px-4 pb-16 lg:max-w-[1040px] lg:px-8">
        {items.length === 0 ? (
          <EmptyState icon={<Bookmark size={28} strokeWidth={1.25} />} title="Nothing saved yet">
            Use “Save view” on any report, or ask for a chart in Ask and save it.
          </EmptyState>
        ) : (
          <ol className="border-t border-rule">
            {items.map((r) => (
              <li key={r.id} className="flex items-center gap-2 border-b border-rule">
                <Link href={`/reports/saved/${r.id}`} className="group min-w-0 flex-1 py-3.5">
                  <span className="display block truncate text-[19px] leading-snug text-ink group-hover:underline group-hover:decoration-1 group-hover:underline-offset-4">{r.name}</span>
                  <span className="mt-0.5 block text-[13px] text-ink-3">
                    {r.kind === "report" ? (reportMeta(r.report ?? "")?.title ?? r.report) : r.kind === "invalid" ? "Can’t be shown" : (KIND[r.chartType ?? ""] ?? "Chart")}
                    {r.kind === "chart" ? " · from Ask" : r.kind === "query" ? " · live" : ""}
                    {r.pinned ? " · pinned" : ""}
                  </span>
                </Link>
                <PinButton id={r.id} pinned={r.pinned} name={r.name} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  );
}
