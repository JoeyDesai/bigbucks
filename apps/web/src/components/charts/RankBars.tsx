"use client";
import { useEffect, useRef, useState } from "react";
import { useChartTheme } from "./tokens";

export interface RankBarItem {
  key: string;
  label: string;
  /** Bar length (any unit; bigint milli is fine). Negative values draw as zero. */
  value: bigint | number;
  /** Right-aligned text (e.g. "$1,234.56"). */
  valueLabel: string;
  /** Muted text after the label. */
  note?: string;
  href?: string;
  color?: string;
}

/** Height a RankBars needs for `n` rows (pass to ChartFrame). */
export const rankBarsHeight = (n: number) => Math.max(n, 1) * ROW;

const ROW = 38;

/**
 * Ranked horizontal bars as plain SVG (so PNG export works): label and value on one line, a 4px
 * bar under it scaled to the largest value. Rows with `href` are links. Use inside ChartFrame.
 */
export function RankBars({ items, max }: { items: RankBarItem[]; max?: bigint | number }) {
  const t = useChartTheme();
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const vals = items.map((i) => (typeof i.value === "bigint" ? Number(i.value) : i.value));
  const top = max !== undefined ? Number(max) : Math.max(1, ...vals);
  const h = rankBarsHeight(items.length);
  return (
    <div ref={ref} className="h-full w-full">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} xmlns="http://www.w3.org/2000/svg" fontFamily={t.font}>
        {items.map((it, i) => {
          const y = i * ROW;
          const frac = top > 0 ? Math.max(0, vals[i]!) / top : 0;
          const label = it.label.length > 42 ? `${it.label.slice(0, 41)}…` : it.label;
          const body = (
            <g>
              <rect x={0} y={y} width={w} height={ROW} fill="transparent" />
              <text x={0} y={y + 16} fontSize={13} fill={t.ink}>
                {label}
                {it.note && (
                  <tspan fill={t.axis} fontSize={12}>
                    {"  "}
                    {it.note}
                  </tspan>
                )}
              </text>
              <text x={w} y={y + 16} fontSize={13} fill={t.ink} textAnchor="end" style={{ fontVariantNumeric: "tabular-nums" }}>
                {it.valueLabel}
              </text>
              <rect x={0} y={y + 24} width={w} height={4} fill={t.grid} />
              <rect x={0} y={y + 24} width={Math.max(frac > 0 ? 2 : 0, frac * w)} height={4} fill={it.color ?? t.series[0]} />
            </g>
          );
          return it.href ? (
            <a key={it.key} href={it.href} aria-label={`${it.label} ${it.valueLabel}`}>
              {body}
            </a>
          ) : (
            <g key={it.key}>{body}</g>
          );
        })}
      </svg>
    </div>
  );
}
