"use client";
import { useState } from "react";
import { BookmarkCheck, BookmarkPlus } from "lucide-react";
import type { ChartSpec } from "@homebase/ai";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { AreaChart, LineChart, StackedBarChart, type Series } from "@/components/charts/CartesianCharts";
import { DonutChart, DonutLegend } from "@/components/charts/DonutChart";
import { SankeyChart } from "@/components/charts/SankeyChart";
import { DataTable } from "@/components/ui/DataTable";

/** Chart specs carry dollars as numbers (charting only); the wrappers take bigint milli. */
const toMilli = (n: number): bigint => BigInt(Math.round(n * 1000));

function fmtValue(v: string | number | null, format: ChartSpec["format"]): string {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (format === "percent") return `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
  if (format === "currency") return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
  return v.toLocaleString("en-US");
}

/** Series → one row per x with a column per series (bigint milli). */
function toRows(spec: ChartSpec): { rows: Record<string, bigint | string>[]; series: Series[] } {
  const series = (spec.series ?? []).map((s, i) => ({ key: `s${i}`, label: s.name }));
  const byX = new Map<string, Record<string, bigint | string>>();
  (spec.series ?? []).forEach((s, i) => {
    for (const p of s.data) {
      const x = String(p.x);
      const row = byX.get(x) ?? { x };
      row[`s${i}`] = toMilli(p.y);
      byX.set(x, row);
    }
  });
  const rows = [...byX.values()].map((r) => {
    for (const s of series) r[s.key] ??= 0n;
    return r;
  });
  return { rows, series };
}

/** Any spec as a table: used for `table`, and for percent/number charts (the chart axes format dollars). */
function SpecTable({ spec }: { spec: ChartSpec }) {
  let columns: string[];
  let rows: (string | number | null)[][];
  if (spec.type === "table") {
    columns = spec.columns ?? [];
    rows = spec.rows ?? [];
  } else if (spec.type === "sankey") {
    columns = ["From", "To", spec.y ?? "Amount"];
    rows = (spec.links ?? []).map((l) => [l.source, l.target, l.value]);
  } else {
    const ss = spec.series ?? [];
    columns = [spec.x ?? "", ...ss.map((s) => s.name)];
    const xs = [...new Set(ss.flatMap((s) => s.data.map((p) => String(p.x))))];
    rows = xs.map((x) => [x, ...ss.map((s) => s.data.find((p) => String(p.x) === x)?.y ?? null)]);
  }
  const numericCol = columns.map((_, c) => rows.length > 0 && rows.every((r) => r[c] === null || typeof r[c] === "number"));
  return (
    <DataTable
      dense
      caption={spec.title}
      rows={rows.map((r, i) => ({ i, r }))}
      rowKey={(x) => String(x.i)}
      maxHeight={360}
      columns={columns.map((c, ci) => ({
        key: String(ci),
        header: c,
        numeric: numericCol[ci],
        render: (x: { r: (string | number | null)[] }) => fmtValue(x.r[ci] ?? null, spec.format),
      }))}
    />
  );
}

function plotFor(spec: ChartSpec) {
  const currency = spec.format === "currency";
  if (spec.type === "pie" && currency) {
    const data = (spec.series?.[0]?.data ?? []).map((p) => ({ label: String(p.x), value: toMilli(p.y) })).sort((a, b) => (b.value > a.value ? 1 : -1));
    return { plot: <DonutChart data={data} centerLabel={spec.y ?? "Total"} />, footer: <DonutLegend data={data.slice(0, 8)} />, height: 220 };
  }
  if (spec.type === "sankey") {
    const links = (spec.links ?? []).map((l) => ({ source: l.source, target: l.target, value: toMilli(l.value) }));
    const nodes = [...new Set(links.flatMap((l) => [l.source, l.target]))];
    return { plot: <SankeyChart nodes={nodes} links={links} />, footer: null, height: 320 };
  }
  if (!currency || spec.type === "table" || spec.type === "pie") return null;
  const { rows, series } = toRows(spec);
  const plot =
    spec.type === "line" ? (
      <LineChart data={rows} xKey="x" series={series} />
    ) : spec.type === "area" ? (
      <AreaChart data={rows} xKey="x" series={series} stacked={false} />
    ) : (
      <StackedBarChart data={rows} xKey="x" series={series} stacked={spec.type === "stacked_bar" || series.length === 1} />
    );
  const legend =
    series.length > 1 ? (
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
        {series.map((s, i) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span aria-hidden className="h-2 w-2" style={{ background: `var(--chart-${(i % 8) + 1})` }} />
            {s.label}
          </li>
        ))}
      </ul>
    ) : null;
  return { plot, footer: legend, height: 240 };
}

function summaryOf(spec: ChartSpec): string {
  const s = spec.series?.[0]?.data ?? [];
  const parts = s.slice(0, 6).map((p) => `${p.x}: ${fmtValue(p.y, spec.format)}`);
  return `${spec.title}. ${parts.join("; ")}${s.length > 6 ? "…" : ""}`;
}

/** An inline render_chart result with "Save as report" (§12.5). */
export function AskChart({ spec, onSave }: { spec: ChartSpec; onSave?: (spec: ChartSpec) => Promise<boolean> }) {
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const p = plotFor(spec);
  const save = onSave && (
    <button
      type="button"
      disabled={saved || busy}
      onClick={async () => {
        setBusy(true);
        const ok = await onSave(spec);
        setBusy(false);
        if (ok) setSaved(true);
      }}
      className="inline-flex min-h-9 items-center gap-1.5 text-[12px] text-ink-2 hover:text-ink disabled:opacity-60"
    >
      {saved ? <BookmarkCheck size={15} strokeWidth={1.75} aria-hidden /> : <BookmarkPlus size={15} strokeWidth={1.75} aria-hidden />}
      {saved ? "Saved to Reports" : "Save as report"}
    </button>
  );
  if (!p)
    return (
      <figure className="min-w-0">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <figcaption className="display text-[17px] leading-tight text-ink">{spec.title}</figcaption>
          {save}
        </div>
        <SpecTable spec={spec} />
      </figure>
    );
  return (
    <ChartFrame title={<span className="text-[17px]">{spec.title}</span>} subtitle={spec.x && spec.y ? `${spec.y} by ${spec.x.toLowerCase()}` : undefined} summary={summaryOf(spec)} height={p.height} actions={save} footer={p.footer}>
      {p.plot}
    </ChartFrame>
  );
}
