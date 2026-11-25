"use client";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useChartTheme } from "./tokens";
import { ChartTooltip } from "./Tooltip";
import { fmtCompact, fmtMonthTick, toChartNumber } from "./util";

export interface Series {
  key: string;
  label: string;
  color?: string;
}

type Row = Record<string, bigint | string>;

/** Convert bigint fields to chart numbers once, at the edge. */
function toRows(data: Row[]): Record<string, number | string>[] {
  return data.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? toChartNumber(v) : v])));
}

interface BaseProps {
  data: Row[];
  /** Category key on the x axis (months as "YYYY-MM-01" get short month ticks). */
  xKey: string;
  series: Series[];
  xFormat?: (v: string) => string;
  /** Y ticks and tooltip values (default: dollars). E.g. days for Age of Money. */
  valueFormat?: { tick: (n: number) => string; tooltip: (n: number) => string };
}

function useAxes(xFormat?: (v: string) => string, valueFormat?: BaseProps["valueFormat"]) {
  const t = useChartTheme();
  const tick = { fill: t.axis, fontSize: 11, fontFamily: t.font };
  const fmtX = xFormat ?? ((v: string) => (/^\d{4}-\d{2}-01$/.test(v) ? fmtMonthTick(v) : v));
  return {
    t,
    grid: <CartesianGrid vertical={false} stroke={t.grid} strokeDasharray="0" />,
    x: (key: string) => <XAxis dataKey={key} tickLine={false} axisLine={{ stroke: t.rule }} tick={tick} tickFormatter={fmtX} interval="preserveStartEnd" minTickGap={12} />,
    y: <YAxis tickLine={false} axisLine={false} tick={tick} tickFormatter={valueFormat?.tick ?? fmtCompact} width={48} />,
    tooltip: (
      <Tooltip
        cursor={{ fill: t.grid, opacity: 0.5 }}
        content={<ChartTooltip valueFormatter={valueFormat?.tooltip} labelFormatter={(l) => (/^\d{4}-\d{2}-01$/.test(l) ? fmtMonthTick(l, true) : l)} />}
      />
    ),
  };
}

/** Stacked monthly bars with an optional dashed average line. Use inside ChartFrame. */
export function StackedBarChart({ data, xKey, series, xFormat, showAverage, stacked = true, valueFormat }: BaseProps & { showAverage?: boolean; /** false = grouped bars side by side. */ stacked?: boolean }) {
  const a = useAxes(xFormat, valueFormat);
  const rows = toRows(data);
  const avg = showAverage && rows.length ? rows.reduce((s, r) => s + series.reduce((ss, se) => ss + Number(r[se.key] ?? 0), 0), 0) / rows.length : null;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap="22%">
        {a.grid}
        {a.x(xKey)}
        {a.y}
        {a.tooltip}
        {series.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId={stacked ? "s" : undefined} fill={s.color ?? a.t.series[i % a.t.series.length]} isAnimationActive animationDuration={450} />
        ))}
        {avg !== null && <ReferenceLine y={avg} stroke={a.t.ink} strokeDasharray="4 3" strokeWidth={1} label={{ value: `avg ${(valueFormat?.tick ?? fmtCompact)(avg)}`, position: "insideTopRight", fill: a.t.ink2, fontSize: 11 }} />}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Simple multi-series line chart. */
export function LineChart({ data, xKey, series, xFormat, valueFormat }: BaseProps) {
  const a = useAxes(xFormat, valueFormat);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={toRows(data)} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        {a.grid}
        {a.x(xKey)}
        {a.y}
        {a.tooltip}
        {series.map((s, i) => (
          <Line key={s.key} dataKey={s.key} name={s.label} type="monotone" stroke={s.color ?? a.t.series[i % a.t.series.length]} strokeWidth={1.75} dot={false} activeDot={{ r: 3 }} isAnimationActive animationDuration={450} />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/**
 * Area chart. `stacked` stacks the series (assets/liabilities); `line` overlays a series as a
 * solid line (e.g. net worth). Use inside ChartFrame.
 */
export function AreaChart({ data, xKey, series, xFormat, stacked = true, line, valueFormat }: BaseProps & { stacked?: boolean; line?: Series }) {
  const a = useAxes(xFormat, valueFormat);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={toRows(data)} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        {a.grid}
        {a.x(xKey)}
        {a.y}
        {a.tooltip}
        <ReferenceLine y={0} stroke={a.t.rule} />
        {series.map((s, i) => {
          const c = s.color ?? a.t.series[i % a.t.series.length];
          return <Area key={s.key} dataKey={s.key} name={s.label} type="monotone" stackId={stacked ? "a" : undefined} stroke={c} strokeWidth={1.25} fill={c} fillOpacity={0.16} isAnimationActive animationDuration={450} />;
        })}
        {line && <Line dataKey={line.key} name={line.label} type="monotone" stroke={line.color ?? a.t.ink} strokeWidth={2} dot={false} isAnimationActive animationDuration={450} />}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
