"use client";
import { useId, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { addDays, formatMilli, milliToNumber } from "@homebase/shared";
import { cx } from "@/lib/cx";
import { formatDay } from "@/lib/format";
import { monotonePath, thin } from "./path";
import { useCountUp } from "./useCountUp";

export type ChartRange = "1M" | "3M" | "6M" | "1Y" | "All";
export const RANGES: ChartRange[] = ["1M", "3M", "6M", "1Y", "All"];
const DAYS: Record<Exclude<ChartRange, "All">, number> = { "1M": 30, "3M": 91, "6M": 182, "1Y": 365 };

export interface ChartPoint {
  date: string;
  balance: bigint;
}

/** The slice of a daily series a range chip shows (always ending at the last point). */
export function sliceRange(points: readonly ChartPoint[], range: ChartRange): ChartPoint[] {
  if (range === "All" || points.length === 0) return [...points];
  const last = points[points.length - 1]!.date;
  const from = addDays(last, -(DAYS[range] - 1));
  return points.filter((p) => p.date >= from);
}

const W = 1000;
const H = 280;
const PAD_T = 18;
const PAD_B = 8;

/**
 * Daily balance area chart: range chips, a line that draws itself in, a soft accent glow and an area
 * wash, and hover/touch scrubbing that shows the date and balance (the header follows the cursor).
 */
export function BalanceChart({ points, title, defaultRange = "3M", className }: { points: ChartPoint[]; title: string; defaultRange?: ChartRange; className?: string }) {
  const [range, setRange] = useState<ChartRange>(defaultRange);
  const [hover, setHover] = useState<number | null>(null);
  const reduce = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const id = useId().replace(/:/g, "");
  const slice = useMemo(() => sliceRange(points, range), [points, range]);
  const shown = useMemo(() => thin(slice, 360), [slice]);
  const geo = useMemo(() => {
    if (shown.length < 2) return null;
    const vs = shown.map((p) => milliToNumber(p.balance));
    let min = Math.min(...vs);
    let max = Math.max(...vs);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.12;
    min -= pad;
    max += pad;
    const x = (i: number) => (i / (shown.length - 1)) * W;
    const y = (v: number) => PAD_T + (1 - (v - min) / (max - min)) * (H - PAD_T - PAD_B);
    const pts = vs.map((v, i) => ({ x: x(i), y: y(v) }));
    const line = monotonePath(pts);
    return { pts, line, area: `${line}L${W},${H - PAD_B}L0,${H - PAD_B}Z`, zeroY: min < 0 && max > 0 ? y(0) : null };
  }, [shown]);

  const first = slice[0];
  const last = slice[slice.length - 1];
  const cur = hover !== null ? shown[hover] : last;
  const change = first && cur ? cur.balance - first.balance : 0n;
  const pct = first && first.balance !== 0n && cur ? (Number(((cur.balance - first.balance) * 10000n) / (first.balance < 0n ? -first.balance : first.balance)) / 100).toFixed(1) : null;
  const headline = useCountUp(last?.balance ?? 0n, { key: "bal" });
  const value = hover !== null && cur ? cur.balance : headline;
  const up = change >= 0n;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || shown.length < 2) return;
    const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setHover(Math.round(t * (shown.length - 1)));
  }

  const hp = hover !== null && geo ? geo.pts[hover] : null;
  const ticks = shown.length > 2 ? [0, Math.floor((shown.length - 1) / 2), shown.length - 1] : [];

  return (
    <section aria-label={title} className={cx("card relative overflow-hidden p-5 sm:p-6", className)}>
      <div aria-hidden className="pointer-events-none absolute -left-20 -top-28 h-64 w-64 rounded-full opacity-50 blur-3xl" style={{ background: "radial-gradient(closest-side, var(--accent-glow), transparent)" }} />
      <div className="relative flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[13px] font-medium text-ink-3" aria-live="polite">
            {hover !== null && cur ? formatDay(cur.date, { withYear: true, weekday: true }) : "Balance"}
          </div>
          <div className="num display mt-0.5 text-[36px] leading-none text-ink sm:text-[44px]" data-testid="chart-balance">
            {formatMilli(value)}
          </div>
          {first && cur && (
            <div className={cx("num mt-2 text-[13.5px] font-semibold", up ? "text-pos" : "text-over")} data-testid="chart-change">
              {up ? "+" : "−"}
              {formatMilli(change < 0n ? -change : change)}
              {pct !== null && <span className="font-medium opacity-80"> ({up ? "+" : ""}{pct}%)</span>}
              <span className="ml-1.5 font-normal text-ink-3">{hover !== null ? `since ${formatDay(first.date)}` : range === "All" ? "all time" : `past ${range}`}</span>
            </div>
          )}
        </div>
        <div role="radiogroup" aria-label="Range" className="inline-flex rounded-full bg-paper-sunken p-1">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={range === r}
              onClick={() => {
                setRange(r);
                setHover(null);
              }}
              className={cx("relative h-8 min-w-[42px] rounded-full px-2.5 text-[12.5px] font-semibold transition-colors", range === r ? "text-ink" : "text-ink-3 hover:text-ink-2")}
            >
              {range === r && <motion.span layoutId={`range-${id}`} className="absolute inset-0 rounded-full bg-paper shadow-[0_1px_2px_rgba(16,20,40,0.08)]" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
              <span className="relative">{r}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="relative mt-5 h-[220px] sm:h-[280px]">
        {!geo ? (
          <div className="flex h-full items-center justify-center text-[14px] text-ink-3">Not enough history yet.</div>
        ) : (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="h-full w-full touch-pan-y overflow-visible"
            onPointerMove={onMove}
            onPointerDown={onMove}
            onPointerLeave={() => setHover(null)}
            role="img"
            aria-label={`${title}: ${formatMilli(first!.balance)} on ${formatDay(first!.date)} to ${formatMilli(last!.balance)} on ${formatDay(last!.date)}`}
            data-testid="balance-chart"
            data-points={shown.length}
          >
            <defs>
              <linearGradient id={`area${id}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.26" />
                <stop offset="70%" stopColor="var(--accent)" stopOpacity="0.04" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
              <filter id={`glow${id}`} x="-5%" y="-30%" width="110%" height="160%">
                <feGaussianBlur stdDeviation="6" />
              </filter>
              <clipPath id={`clip${id}`}>
                <motion.rect key={range} x="0" y="-20" height={H + 40} initial={reduce ? false : { width: 0 }} animate={{ width: W + 10 }} transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }} />
              </clipPath>
            </defs>
            {[0.25, 0.5, 0.75].map((f) => (
              <line key={f} x1="0" x2={W} y1={PAD_T + f * (H - PAD_T - PAD_B)} y2={PAD_T + f * (H - PAD_T - PAD_B)} stroke="var(--chart-grid)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            ))}
            {geo.zeroY !== null && <line x1="0" x2={W} y1={geo.zeroY} y2={geo.zeroY} stroke="var(--rule-strong)" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />}
            <g clipPath={`url(#clip${id})`}>
              <path d={geo.area} fill={`url(#area${id})`} />
              <path d={geo.line} fill="none" stroke="var(--accent)" strokeWidth="6" strokeOpacity="0.45" filter={`url(#glow${id})`} vectorEffect="non-scaling-stroke" />
              <path d={geo.line} fill="none" stroke="var(--accent)" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" data-testid="chart-line" />
            </g>
            {hp && (
              <g pointerEvents="none">
                <line x1={hp.x} x2={hp.x} y1={PAD_T - 6} y2={H - PAD_B} stroke="var(--ink-3)" strokeOpacity="0.5" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
              </g>
            )}
          </svg>
        )}
        {hp && (
          <span
            aria-hidden
            className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-paper bg-accent shadow-[0_0_0_4px_var(--accent-soft),0_0_16px_var(--accent-glow)]"
            style={{ left: `${(hp.x / W) * 100}%`, top: `${(hp.y / H) * 100}%` }}
          />
        )}
      </div>
      {ticks.length > 0 && (
        <div aria-hidden className="num relative mt-1 flex justify-between text-[11.5px] text-ink-3">
          {ticks.map((i) => (
            <span key={i}>{formatDay(shown[i]!.date, { withYear: range === "All" || range === "1Y" })}</span>
          ))}
        </div>
      )}
    </section>
  );
}
