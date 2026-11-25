"use client";
import { useEffect, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { formatMonth, milliToNumber, type Milli, type Month } from "@homebase/shared";
import { cx } from "@/lib/cx";
import { dollars } from "@/lib/format";
import { barAxis } from "@/lib/reflect";

const H = 210;
const PAD_T = 22;
const PAD_B = 26;
const PAD_L = 46;

/** "Oct" (or "Oct ’25" for January and the first month). */
export function shortMonth(m: Month, withYear = false): string {
  const d = new Date(`${m}T12:00:00Z`);
  const mon = d.toLocaleDateString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  return withYear ? `${mon} ’${String(d.getUTCFullYear()).slice(2)}` : mon;
}

export function useWidth<T extends Element>() {
  const [el, setEl] = useState<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, w] as const;
}

/** "$69k" for big amounts, else whole dollars. */
function compactDollars(m: Milli): string {
  return m >= 10_000_000n ? `$${(m + 500_000n) / 1_000_000n}k` : dollars(m);
}

/** A bar with 4px rounded top corners standing on the baseline. */
function barPath(x: number, w: number, top: number, base: number): string {
  const h = base - top;
  if (h <= 0.5) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
}

/**
 * Monthly bars on one dollar axis: the selected month in full color, the rest quieter. Optional per-month
 * `marker` ticks (e.g. income) and a dashed `goal` line share the same axis. Hover or tap shows a
 * tooltip; clicking a bar calls `onSelect`. A month that towers over the rest is drawn clipped (a
 * break across the top) with its real total above it.
 */
export function MonthBars({
  months,
  values,
  selected,
  onSelect,
  color = "var(--accent)",
  marker,
  goal,
  label,
  tooltip,
  testId,
}: {
  months: readonly Month[];
  values: readonly Milli[];
  selected: number;
  onSelect?: (i: number) => void;
  color?: string;
  marker?: { values: readonly Milli[]; label: string };
  goal?: { value: Milli; label: string } | null;
  label: string;
  tooltip: (i: number) => ReactNode;
  testId?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const reduce = useReducedMotion();
  const n = months.length;
  const { max, clipped } = barAxis(values, [...(marker?.values ?? []), goal?.value ?? 0n]);
  const plotW = Math.max(0, width - PAD_L);
  const slot = n ? plotW / n : 0;
  const bw = Math.min(34, Math.max(6, slot * 0.6));
  const base = H - PAD_B;
  const y = (v: Milli) => PAD_T + (1 - Math.max(0, Math.min(1, milliToNumber(v) / milliToNumber(max)))) * (base - PAD_T);
  const xOf = (i: number) => PAD_L + i * slot + (slot - bw) / 2;
  const every = slot < 30 ? 2 : 1;
  const tip = hover ?? null;

  return (
    <div className="relative min-w-0" data-testid={testId}>
      {/* the svg is absolutely placed so its measured width never props the layout open */}
      <div ref={ref} className="relative w-full" style={{ height: H }}>
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label={label} className="absolute left-0 top-0 block overflow-visible" onPointerLeave={() => setHover(null)}>
            {[0, 0.5, 1].map((f) => {
              const v = BigInt(Math.round(Number(max) * f));
              const yy = y(v);
              return (
                <g key={f}>
                  <line x1={PAD_L} x2={width} y1={yy} y2={yy} stroke={f === 0 ? "var(--rule-strong)" : "var(--chart-grid)"} strokeWidth="1" />
                  <text x={PAD_L - 8} y={yy} dy="0.32em" textAnchor="end" className="num fill-[var(--chart-axis)] text-[11px]">
                    {dollars(v)}
                  </text>
                </g>
              );
            })}
            {months.map((m, i) => {
              const v = values[i] ?? 0n;
              const on = i === selected;
              const hot = i === hover;
              return (
                <g key={m}>
                  <motion.path
                    d={barPath(xOf(i), bw, y(v), base)}
                    fill={color}
                    fillOpacity={on || hot ? 1 : 0.38}
                    initial={reduce ? false : { scaleY: 0 }}
                    animate={{ scaleY: 1 }}
                    transition={{
                      delay: 0.05 + i * 0.03,
                      duration: 0.6,
                      ease: [0.16, 1, 0.3, 1],
                    }}
                    style={{
                      transformBox: "fill-box",
                      transformOrigin: "bottom",
                      filter: on ? `drop-shadow(0 0 10px ${color === "var(--accent)" ? "var(--accent-glow)" : "transparent"})` : undefined,
                    }}
                  />
                  {clipped.includes(i) && (
                    <g pointerEvents="none">
                      <path d={`M${xOf(i) - 2},${PAD_T + 16}L${xOf(i) + bw + 2},${PAD_T + 10}M${xOf(i) - 2},${PAD_T + 22}L${xOf(i) + bw + 2},${PAD_T + 16}`} stroke="var(--paper-raised)" strokeWidth="3" />
                      <text x={xOf(i) + bw / 2} y={PAD_T - 7} textAnchor="middle" className="num fill-[var(--ink-2)] text-[11px] font-semibold">
                        {compactDollars(v)}
                      </text>
                    </g>
                  )}
                  {marker && (marker.values[i] ?? 0n) > 0n && (
                    <line
                      x1={xOf(i) - 3}
                      x2={xOf(i) + bw + 3}
                      y1={y(marker.values[i]!)}
                      y2={y(marker.values[i]!)}
                      stroke="var(--ink-2)"
                      strokeWidth="2"
                      strokeLinecap="round"
                      opacity={on || hot ? 1 : 0.55}
                    />
                  )}
                  {i % every === (n - 1) % every && (
                    <text x={xOf(i) + bw / 2} y={H - 8} textAnchor="middle" className={cx("text-[11px]", on ? "fill-[var(--ink)] font-semibold" : "fill-[var(--chart-axis)]")}>
                      {shortMonth(m, i === 0 || m.slice(5, 7) === "01")}
                    </text>
                  )}
                  <rect
                    x={PAD_L + i * slot}
                    y={PAD_T}
                    width={slot}
                    height={base - PAD_T + PAD_B}
                    fill="transparent"
                    className={onSelect ? "cursor-pointer" : undefined}
                    onPointerEnter={() => setHover(i)}
                    onPointerDown={() => setHover(i)}
                    onClick={() => onSelect?.(i)}
                    aria-hidden
                  />
                </g>
              );
            })}
            {goal && goal.value > 0n && (
              <g pointerEvents="none">
                <line x1={PAD_L} x2={width} y1={y(goal.value)} y2={y(goal.value)} stroke="var(--ink-2)" strokeWidth="1.5" strokeDasharray="5 5" />
                <text x={width} y={y(goal.value) - 6} textAnchor="end" className="fill-[var(--ink-2)] text-[11px] font-medium">
                  {goal.label}
                </text>
              </g>
            )}
          </svg>
        )}
        {tip !== null && width > 0 && (
          <div
            role="status"
            className="pointer-events-none absolute z-10 min-w-[150px] -translate-x-1/2 rounded-[12px] border border-rule bg-paper-raised px-3 py-2 text-[12.5px] shadow-pop"
            style={{
              left: Math.min(Math.max(xOf(tip) + bw / 2, 80), width - 80),
              top: Math.max(0, y(values[tip] ?? 0n) - 78),
            }}
          >
            <div className="mb-1 font-semibold text-ink">{formatMonth(months[tip]!)}</div>
            {tooltip(tip)}
          </div>
        )}
      </div>
      {marker && (
        <div className="mt-2 flex items-center gap-4 text-[12px] text-ink-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color }} aria-hidden /> Spent
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-[2px] w-3.5 rounded-full bg-ink-2" aria-hidden /> {marker.label}
          </span>
        </div>
      )}
    </div>
  );
}

/** One "label  $amount" line inside a chart tooltip. */
export function TipRow({ label, value, tone }: { label: string; value: Milli; tone?: "pos" | "over" }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-ink-3">{label}</span>
      <span className={cx("num font-semibold", tone === "pos" ? "text-pos" : tone === "over" ? "text-over" : "text-ink")}>{dollars(value)}</span>
    </div>
  );
}
