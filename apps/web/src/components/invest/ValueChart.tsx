"use client";
import { useId, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { milliToNumber, type Milli } from "@homebase/shared";
import { dollars, formatDay } from "@/lib/format";
import { useWidth } from "@/components/reflect/MonthBars";

const PAD_T = 14;
const PAD_B = 26;
const PAD_L = 52;

export interface ValueLayer {
  id: string;
  label: string;
  color: string;
  values: readonly Milli[];
}

/** "$412k" / "$9.5k" / "$800" for axis labels. */
export function compact(m: Milli): string {
  const n = Math.abs(milliToNumber(m));
  const s = n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;
  return `${m < 0n ? "-" : ""}$${s}`;
}

function tickLabel(d: string, long: boolean): string {
  if (!long) return formatDay(d);
  const dt = new Date(`${d}T12:00:00Z`);
  return `${dt.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })} ’${String(dt.getUTCFullYear()).slice(2)}`;
}

/**
 * Value over time. Several layers stack (all accounts, zero baseline); a single layer is drawn as a line
 * with a soft fill on a tight axis so a year of growth is visible. Hover or drag for a crosshair and the
 * value on that day.
 */
export function ValueChart({ dates, layers, height = 240, label }: { dates: readonly string[]; layers: ValueLayer[]; height?: number; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const reduce = useReducedMotion();
  const gid = useId().replace(/:/g, "");
  const n = dates.length;
  const stacked = layers.length > 1;
  const totals = dates.map((_, i) => layers.reduce((s, l) => s + (l.values[i] ?? 0n), 0n));
  const nums = totals.map(milliToNumber);
  const hi = Math.max(1, ...nums);
  const lo = stacked ? 0 : Math.min(...nums);
  const padY = stacked ? hi * 0.06 : Math.max((hi - lo) * 0.12, hi * 0.01);
  const yMax = hi + padY;
  const yMin = stacked ? 0 : Math.max(0, lo - padY);
  const base = height - PAD_B;
  const plotW = Math.max(0, width - PAD_L);
  const x = (i: number) => PAD_L + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD_T + (1 - (v - yMin) / (yMax - yMin || 1)) * (base - PAD_T);
  const longSpan = n > 1 && Date.parse(dates[n - 1]!) - Date.parse(dates[0]!) > 120 * 86_400_000;

  // running tops per layer, bottom layer first
  const tops: number[][] = [];
  const acc = dates.map(() => 0);
  for (const l of layers) {
    tops.push(dates.map((_, i) => (acc[i]! += milliToNumber(l.values[i] ?? 0n))));
  }
  const line = (ys: number[]) => ys.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = (top: number[], bottom: number[] | null) =>
    `${line(top)}L${x(n - 1).toFixed(1)},${bottom ? y(bottom[n - 1]!).toFixed(1) : base}${bottom ? bottom.map((_, k) => `L${x(n - 1 - k).toFixed(1)},${y(bottom[n - 1 - k]!).toFixed(1)}`).join("") : `L${x(0).toFixed(1)},${base}`}Z`;

  const ticks = n > 1 ? [0, Math.round((n - 1) / 3), Math.round(((n - 1) * 2) / 3), n - 1] : [0];
  const grid = [0, 0.5, 1].map((f) => yMin + (yMax - padY - yMin) * f);
  const pick = (clientX: number, el: SVGSVGElement) => {
    const r = el.getBoundingClientRect();
    const px = clientX - r.left - PAD_L;
    setHover(Math.max(0, Math.min(n - 1, Math.round((px / (plotW || 1)) * (n - 1)))));
  };

  return (
    <div className="relative min-w-0" data-testid="invest-chart">
      <div ref={ref} className="relative w-full" style={{ height }}>
        {width > 0 && n > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={label}
            className="absolute left-0 top-0 block touch-pan-y overflow-visible"
            onPointerMove={(e) => pick(e.clientX, e.currentTarget)}
            onPointerDown={(e) => pick(e.clientX, e.currentTarget)}
            onPointerLeave={() => setHover(null)}
          >
            <defs>
              <clipPath id={`clip-${gid}`}>
                <motion.rect x={0} y={0} height={height} initial={reduce ? false : { width: 0 }} animate={{ width }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }} width={width} />
              </clipPath>
              {!stacked && layers[0] && (
                <linearGradient id={`fill-${gid}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={layers[0].color} stopOpacity="0.28" />
                  <stop offset="100%" stopColor={layers[0].color} stopOpacity="0" />
                </linearGradient>
              )}
            </defs>
            {grid.map((v, k) => (
              <g key={k}>
                <line x1={PAD_L} x2={width} y1={y(v)} y2={y(v)} stroke={k === 0 && stacked ? "var(--rule-strong)" : "var(--chart-grid)"} strokeWidth="1" />
                <text x={PAD_L - 8} y={y(v)} dy="0.32em" textAnchor="end" className="num fill-[var(--chart-axis)] text-[11px]">
                  {compact(BigInt(Math.round(v * 1000)))}
                </text>
              </g>
            ))}
            {ticks.map((i, k) => (
              <text key={k} x={x(i)} y={height - 8} textAnchor={k === 0 ? "start" : k === ticks.length - 1 ? "end" : "middle"} className="fill-[var(--chart-axis)] text-[11px]">
                {tickLabel(dates[i]!, longSpan)}
              </text>
            ))}
            <g clipPath={`url(#clip-${gid})`}>
              {stacked ? (
                layers.map((l, k) => (
                  <g key={l.id}>
                    <path d={area(tops[k]!, k ? tops[k - 1]! : null)} fill={l.color} fillOpacity={0.22} />
                    {/* 2px surface gap between bands, then the band's top edge */}
                    <path d={line(tops[k]!)} fill="none" stroke="var(--paper-raised)" strokeWidth="3" strokeLinejoin="round" />
                    <path d={line(tops[k]!)} fill="none" stroke={l.color} strokeWidth="1.5" strokeLinejoin="round" />
                  </g>
                ))
              ) : (
                <>
                  <path d={area(tops[0]!, null)} fill={`url(#fill-${gid})`} />
                  <path d={line(tops[0]!)} fill="none" stroke={layers[0]!.color} strokeWidth="2" strokeLinejoin="round" style={{ filter: "drop-shadow(0 0 8px var(--accent-glow))" }} />
                </>
              )}
            </g>
            {hover !== null && (
              <g pointerEvents="none">
                <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={base} stroke="var(--ink-3)" strokeWidth="1" strokeDasharray="3 3" />
                {tops.map((t, k) => (
                  <circle key={k} cx={x(hover)} cy={y(t[hover]!)} r={4.5} fill={layers[k]!.color} stroke="var(--paper-raised)" strokeWidth="2" />
                ))}
              </g>
            )}
          </svg>
        )}
        {hover !== null && width > 0 && (
          <div
            role="status"
            className="pointer-events-none absolute top-0 z-10 min-w-[170px] -translate-x-1/2 rounded-[12px] border border-rule bg-paper-raised px-3 py-2 text-[12.5px] shadow-pop"
            style={{ left: Math.min(Math.max(x(hover), 95), width - 95) }}
          >
            <div className="mb-1 flex items-baseline justify-between gap-4">
              <span className="font-semibold text-ink">{formatDay(dates[hover]!, { withYear: true })}</span>
              <span className="num font-semibold text-ink">{dollars(totals[hover]!)}</span>
            </div>
            {stacked &&
              [...layers].reverse().map((l) => (
                <div key={l.id} className="flex items-center justify-between gap-4">
                  <span className="flex min-w-0 items-center gap-1.5 text-ink-3">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: l.color }} aria-hidden />
                    <span className="truncate">{l.label}</span>
                  </span>
                  <span className="num text-ink-2">{dollars(l.values[hover] ?? 0n)}</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
