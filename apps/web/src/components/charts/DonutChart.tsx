"use client";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { formatMilli } from "@homebase/shared";
import type { ChartDatum } from "@/lib/view-models";
import { useChartTheme } from "./tokens";
import { ChartTooltip } from "./Tooltip";
import { toChartNumber } from "./util";

/** Series color for slice i; "Other" and anything past the palette fall back to neutral gray. */
function sliceColor(d: ChartDatum, i: number, t: ReturnType<typeof useChartTheme>): string {
  if (d.color) return d.color;
  if (d.label === "Other" || i >= t.series.length) return t.axis;
  return t.series[i]!;
}

export interface DonutChartProps {
  data: ChartDatum[];
  /** Small label above the center figure (e.g. "Spent"). */
  centerLabel?: string;
  /** Center figure; defaults to the sum of data. */
  centerValue?: bigint;
}

/** Donut with a serif total in the middle. Colors: datum.color or the token series. Use inside ChartFrame. */
export function DonutChart({ data, centerLabel = "Total", centerValue }: DonutChartProps) {
  const t = useChartTheme();
  const total = centerValue ?? data.reduce((a, d) => a + d.value, 0n);
  const rows = data.map((d, i) => ({ name: d.label, value: toChartNumber(d.value), fill: sliceColor(d, i, t) }));
  return (
    <div className="relative h-full w-full">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={rows} dataKey="value" nameKey="name" innerRadius="70%" outerRadius="98%" paddingAngle={0.6} stroke={t.paper} strokeWidth={1.5} startAngle={90} endAngle={-270} isAnimationActive animationDuration={500}>
            {rows.map((r) => (
              <Cell key={r.name} fill={r.fill} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="eyebrow">{centerLabel}</span>
        <span className="display num mt-1 text-[24px] leading-none text-ink">{formatMilli(total, { cents: false })}</span>
      </div>
    </div>
  );
}

/** Ranked legend list that pairs with DonutChart. */
export function DonutLegend({ data, total }: { data: ChartDatum[]; total?: bigint }) {
  const t = useChartTheme();
  const sum = total ?? data.reduce((a, d) => a + d.value, 0n);
  return (
    <ol className="divide-y divide-rule border-y border-rule">
      {data.map((d, i) => {
        const pct = sum > 0n ? Number((d.value * 1000n) / sum) / 10 : 0;
        return (
          <li key={d.label} className="flex items-center gap-3 py-2 text-[14px]">
            <span aria-hidden className="h-2.5 w-2.5 shrink-0" style={{ background: sliceColor(d, i, t) }} />
            <span className="min-w-0 flex-1 truncate">{d.label}</span>
            <span className="num w-12 text-right text-[12px] text-ink-3">{pct.toFixed(1)}%</span>
            <span className="num w-24 text-right">{formatMilli(d.value)}</span>
          </li>
        );
      })}
    </ol>
  );
}
