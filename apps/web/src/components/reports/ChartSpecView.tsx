"use client";
import type { ChartSpec } from "@homebase/ai";
import { dollarsToMilli } from "@homebase/shared";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { AreaChart, LineChart, StackedBarChart } from "@/components/charts/CartesianCharts";
import { ComboChart } from "@/components/charts/ComboChart";
import { DonutChart, DonutLegend } from "@/components/charts/DonutChart";
import { SankeyChart } from "@/components/charts/SankeyChart";
import { DataTable } from "@/components/ui/DataTable";

/** ChartSpec values are display numbers (dollars or percent); convert at the chart edge only. */
const toMilli = (n: number) => dollarsToMilli(n);

const fmtFor = (spec: ChartSpec) =>
  spec.format === "currency"
    ? undefined
    : spec.format === "percent"
      ? { tick: (n: number) => `${Math.round(n)}%`, tooltip: (n: number) => `${n.toFixed(1)}%` }
      : { tick: (n: number) => String(Math.round(n)), tooltip: (n: number) => n.toLocaleString("en-US") };

/** Renders a saved Ask chart (`ChartSpecSchema`) with the app's chart wrappers. */
export function ChartSpecView({ spec }: { spec: ChartSpec }) {
  const series = spec.series ?? [];
  const xs = [...new Set(series.flatMap((s) => s.data.map((d) => String(d.x))))];
  const rows = xs.map((x) => ({ x, ...Object.fromEntries(series.map((s, i) => [`s${i}`, toMilli(s.data.find((d) => String(d.x) === x)?.y ?? 0)])) }));
  const keys = series.map((s, i) => ({ key: `s${i}`, label: s.name }));
  const vf = fmtFor(spec);
  const summary = `${spec.title}: ${spec.type.replace("_", " ")} chart`;

  if (spec.type === "table") {
    type TRow = { i: number; r: (string | number | null)[] };
    return (
      <DataTable<TRow>
        caption={spec.title}
        rows={(spec.rows ?? []).map((r, i) => ({ i, r }))}
        rowKey={(x) => String(x.i)}
        columns={(spec.columns ?? []).map((c, ci) => ({ key: String(ci), header: c, numeric: typeof spec.rows?.[0]?.[ci] === "number", render: (x) => (x.r[ci] === null ? "—" : String(x.r[ci])) }))}
      />
    );
  }
  if (spec.type === "pie") {
    const data = (series[0]?.data ?? []).map((d) => ({ label: String(d.x), value: toMilli(d.y) }));
    return (
      <div data-report-chart>
        <ChartFrame summary={summary} height={260} footer={<DonutLegend data={data} />}>
          <DonutChart data={data} />
        </ChartFrame>
      </div>
    );
  }
  if (spec.type === "sankey") {
    const links = (spec.links ?? []).map((l) => ({ source: l.source, target: l.target, value: toMilli(l.value) }));
    const nodes = [...new Set(links.flatMap((l) => [l.source, l.target]))];
    return (
      <div data-report-chart>
        <ChartFrame summary={summary} height={420}>
          <SankeyChart nodes={nodes} links={links} />
        </ChartFrame>
      </div>
    );
  }
  return (
    <div data-report-chart>
      <ChartFrame summary={summary} height={320} subtitle={spec.y}>
        {spec.type === "line" ? (
          <LineChart data={rows} xKey="x" series={keys} valueFormat={vf} />
        ) : spec.type === "area" ? (
          <AreaChart data={rows} xKey="x" series={keys} valueFormat={vf} />
        ) : spec.type === "stacked_bar" ? (
          <StackedBarChart data={rows} xKey="x" series={keys} valueFormat={vf} />
        ) : (
          <ComboChart data={rows} xKey="x" bars={keys} valueFormat={vf} />
        )}
      </ChartFrame>
    </div>
  );
}
