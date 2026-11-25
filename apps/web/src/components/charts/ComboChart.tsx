"use client";
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useChartTheme } from "./tokens";
import { ChartTooltip } from "./Tooltip";
import { fmtCompact, fmtMonthTick, toChartNumber } from "./util";

export interface ComboSeries {
  key: string;
  label: string;
  color?: string;
  /** Lines only: dashed. */
  dashed?: boolean;
}

export interface ComboChartProps {
  data: Record<string, bigint | number | string | null>[];
  xKey: string;
  bars: ComboSeries[];
  lines?: ComboSeries[];
  /** Stack the bars (positive and negative values stack away from zero). Default: side by side. */
  stacked?: boolean;
  /** Dashed horizontal reference line (same units as the data; bigint = milli). */
  average?: { value: bigint | number; label?: string };
  /** Y ticks and tooltip values (default: dollars; bigint fields are converted from milli). */
  valueFormat?: { tick: (n: number) => string; tooltip: (n: number) => string };
  xFormat?: (v: string) => string;
}

const num = (v: bigint | number) => (typeof v === "bigint" ? toChartNumber(v) : v);

/**
 * Bars (grouped or sign-stacked) with optional overlay lines and an average rule — monthly
 * income/expense with a net line, contributions vs market change, assigned vs spent. Use inside ChartFrame.
 */
export function ComboChart({ data, xKey, bars, lines = [], stacked, average, valueFormat, xFormat }: ComboChartProps) {
  const t = useChartTheme();
  const rows = data.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? toChartNumber(v) : v])));
  const tick = { fill: t.axis, fontSize: 11, fontFamily: t.font };
  const fmtX = xFormat ?? ((v: string) => (/^\d{4}-\d{2}-01$/.test(v) ? fmtMonthTick(v) : v));
  const fmtY = valueFormat?.tick ?? fmtCompact;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap={stacked ? "22%" : "18%"} barGap={1} stackOffset={stacked ? "sign" : undefined}>
        <CartesianGrid vertical={false} stroke={t.grid} strokeDasharray="0" />
        <XAxis dataKey={xKey} tickLine={false} axisLine={{ stroke: t.rule }} tick={tick} tickFormatter={fmtX} interval="preserveStartEnd" minTickGap={12} />
        <YAxis tickLine={false} axisLine={false} tick={tick} tickFormatter={fmtY} width={48} />
        <Tooltip
          cursor={{ fill: t.grid, opacity: 0.5 }}
          content={<ChartTooltip valueFormatter={valueFormat?.tooltip} labelFormatter={(l) => (/^\d{4}-\d{2}-01$/.test(l) ? fmtMonthTick(l, true) : l)} />}
        />
        <ReferenceLine y={0} stroke={t.rule} />
        {bars.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId={stacked ? "s" : undefined} fill={s.color ?? t.series[i % t.series.length]} isAnimationActive animationDuration={450} />
        ))}
        {lines.map((s) => (
          <Line
            key={s.key}
            dataKey={s.key}
            name={s.label}
            type="monotone"
            stroke={s.color ?? t.ink}
            strokeWidth={s.dashed ? 1.25 : 2}
            strokeDasharray={s.dashed ? "4 3" : undefined}
            dot={false}
            activeDot={{ r: 3 }}
            connectNulls
            isAnimationActive
            animationDuration={450}
          />
        ))}
        {average && (
          <ReferenceLine
            y={num(average.value)}
            stroke={t.ink}
            strokeDasharray="4 3"
            strokeWidth={1}
            label={{ value: average.label ?? `avg ${fmtY(num(average.value))}`, position: "insideTopRight", fill: t.ink2, fontSize: 11 }}
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
