"use client";
import { useState, useTransition } from "react";
import { Bookmark, Download, Image as ImageIcon } from "lucide-react";
import { saveReportViewAction } from "@/app/(app)/reports/actions";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { exportChartPng } from "./exportPng";

export interface ReportActionsProps {
  slug: string;
  /** Current query string, with leading "?" or empty. */
  search: string;
  title: string;
  subtitle: string;
  /** CSS selector of the element holding the chart (for PNG). */
  chartSelector?: string;
  canSave?: boolean;
}

/** Export CSV (server route), export PNG (client, from the chart SVG), save this view. */
export function ReportActions({ slug, search, title, subtitle, chartSelector = "[data-report-chart]", canSave = true }: ReportActionsProps) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(title);
  const [busy, start] = useTransition();
  const file = `${slug}-${new Date().toISOString().slice(0, 10)}`;

  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
      <a
        href={`/reports/${slug}/export${search}`}
        download={`${file}.csv`}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-sm px-2 text-[13px] font-medium text-ink-2 hover:bg-paper-sunken hover:text-ink"
      >
        <Download size={15} strokeWidth={1.75} aria-hidden /> CSV
      </a>
      <button
        type="button"
        className="inline-flex min-h-9 items-center gap-1.5 rounded-sm px-2 text-[13px] font-medium text-ink-2 hover:bg-paper-sunken hover:text-ink"
        onClick={async () => {
          const el = document.querySelector(chartSelector);
          if (!el) return;
          try {
            await exportChartPng(el, { title, subtitle, filename: `${file}.png` });
          } catch (e) {
            toast.show({ message: e instanceof Error ? e.message : "Export failed", tone: "error" });
          }
        }}
      >
        <ImageIcon size={15} strokeWidth={1.75} aria-hidden /> PNG
      </button>
      {canSave &&
        (saving ? (
          <form
            className="flex w-full items-center gap-2 sm:w-auto"
            onSubmit={(e) => {
              e.preventDefault();
              start(async () => {
                const r = await saveReportViewAction({ slug: slug as "spending-breakdown", search, name, pinned: true });
                if (r.ok) {
                  setSaving(false);
                  toast.show({ message: `Saved “${name}” to Reports` });
                } else toast.show({ message: r.error, tone: "error" });
              });
            }}
          >
            <label className="min-w-0 flex-1">
              <span className="sr-only">Report name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus className="min-h-9 w-full rounded-sm border border-rule-strong bg-paper px-2 text-[14px] sm:w-56" />
            </label>
            <Button type="submit" size="sm" variant="primary" busy={busy}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSaving(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setSaving(true)}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-sm px-2 text-[13px] font-medium text-ink-2 hover:bg-paper-sunken hover:text-ink"
          >
            <Bookmark size={15} strokeWidth={1.75} aria-hidden /> Save view
          </button>
        ))}
    </div>
  );
}
