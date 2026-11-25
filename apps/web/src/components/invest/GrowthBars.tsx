"use client";
import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { formatMonth, milliToNumber, type Milli, type Month } from "@homebase/shared";
import { cx } from "@/lib/cx";
import { shortMonth, TipRow, useWidth } from "@/components/reflect/MonthBars";
import { compact } from "./ValueChart";

const H = 220;
const PAD_T = 12;
const PAD_B = 26;
const PAD_L = 52;

export interface GrowthMonthVM {
  month: string;
  contributions: Milli;
  market: Milli;
  known: boolean;
  partial: boolean;
}

/** Rounded data-end on a bar segment: up = round the top corners, down = the bottom ones. */
function seg(x: number, w: number, y0: number, y1: number, round: "up" | "down" | null): string {
  const top = Math.min(y0, y1);
  const bot = Math.max(y0, y1);
  if (bot - top < 0.5) return "";
  const r = round ? Math.min(4, w / 2, bot - top) : 0;
  if (round === "up") return `M${x},${bot}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${bot}Z`;
  if (round === "down") return `M${x},${top}V${bot - r}Q${x},${bot} ${x + r},${bot}H${x + w - r}Q${x + w},${bot} ${x + w},${bot - r}V${top}Z`;
  return `M${x},${top}H${x + w}V${bot}H${x}Z`;
}

/**
 * Month by month: what you put in (blue, from zero up) and what the market did (green on top when it
 * grew, red below zero when it fell). One dollar axis; hover or tap a month for the numbers.
 */
export function GrowthBars({ months, label }: { months: GrowthMonthVM[]; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const reduce = useReducedMotion();
  const n = months.length;
  const ups = months.map((m) => milliToNumber(m.contributions > 0n ? m.contributions : 0n) + milliToNumber(m.market > 0n ? m.market : 0n));
  const downs = months.map((m) => milliToNumber(m.contributions < 0n ? m.contributions : 0n) + milliToNumber(m.market < 0n ? m.market : 0n));
  const yMax = Math.max(1, ...ups) * 1.08;
  const yMin = Math.min(0, ...downs) * 1.08;
  const base = H - PAD_B;
  const y = (v: number) => PAD_T + ((yMax - v) / (yMax - yMin || 1)) * (base - PAD_T);
  const plotW = Math.max(0, width - PAD_L);
  const slot = n ? plotW / n : 0;
  const bw = Math.min(30, Math.max(6, slot * 0.56));
  const xOf = (i: number) => PAD_L + i * slot + (slot - bw) / 2;
  const every = slot < 30 ? 2 : 1;
  const grid = yMin < 0 ? [yMin / 1.08, 0, yMax / 1.08] : [0, yMax / 2.16, yMax / 1.08];

  return (
    <div className="relative min-w-0" data-testid="invest-growth">
      <div ref={ref} className="relative w-full" style={{ height: H }}>
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label={label} className="absolute left-0 top-0 block overflow-visible" onPointerLeave={() => setHover(null)}>
            {grid.map((v, k) => (
              <g key={k}>
                <line x1={PAD_L} x2={width} y1={y(v)} y2={y(v)} stroke={v === 0 ? "var(--rule-strong)" : "var(--chart-grid)"} strokeWidth="1" />
                <text x={PAD_L - 8} y={y(v)} dy="0.32em" textAnchor="end" className="num fill-[var(--chart-axis)] text-[11px]">
                  {compact(BigInt(Math.round(v * 1000)))}
                </text>
              </g>
            ))}
            {months.map((m, i) => {
              const c = Math.max(0, milliToNumber(m.contributions));
              const mk = milliToNumber(m.market);
              const on = hover === i;
              const x = xOf(i);
              const contribTop = y(c);
              const marketUp = mk > 0 ? seg(x, bw, contribTop - 2, y(c + mk), "up") : "";
              const marketDown = mk < 0 ? seg(x, bw, y(0) + (c > 0 ? 2 : 0), y(mk), "down") : "";
              return (
                <motion.g
                  key={m.month}
                  initial={reduce ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.04 + i * 0.03, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                  opacity={hover === null || on ? 1 : 0.55}
                >
                  <path d={seg(x, bw, y(0), contribTop, mk > 0 ? null : "up")} fill="var(--cat-1)" fillOpacity={m.partial ? 0.55 : 1} />
                  {marketUp && <path d={marketUp} fill="var(--pos-bar)" fillOpacity={m.partial ? 0.55 : 1} />}
                  {marketDown && <path d={marketDown} fill="var(--over)" fillOpacity={m.partial ? 0.55 : 0.9} />}
                  {i % every === (n - 1) % every && (
                    <text x={x + bw / 2} y={H - 8} textAnchor="middle" className={cx("text-[11px]", on ? "fill-[var(--ink)] font-semibold" : "fill-[var(--chart-axis)]")}>
                      {shortMonth(m.month as Month, i === 0 || m.month.slice(5, 7) === "01")}
                    </text>
                  )}
                  <rect x={PAD_L + i * slot} y={PAD_T} width={slot} height={base - PAD_T + PAD_B} fill="transparent" onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)} aria-hidden />
                </motion.g>
              );
            })}
          </svg>
        )}
        {hover !== null && width > 0 && months[hover] && (
          <div
            role="status"
            className="pointer-events-none absolute top-0 z-10 min-w-[180px] -translate-x-1/2 rounded-[12px] border border-rule bg-paper-raised px-3 py-2 text-[12.5px] shadow-pop"
            style={{ left: Math.min(Math.max(xOf(hover) + bw / 2, 100), width - 100) }}
          >
            <div className="mb-1 font-semibold text-ink">
              {formatMonth(months[hover].month as Month)}
              {months[hover].partial ? " so far" : ""}
            </div>
            <TipRow label="Put in" value={months[hover].contributions} />
            <TipRow label={months[hover].known ? "Market" : "Market + other"} value={months[hover].market} tone={months[hover].market >= 0n ? "pos" : "over"} />
            <TipRow label="Total change" value={months[hover].contributions + months[hover].market} />
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px] bg-[var(--cat-1)]" aria-hidden /> Put in
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px] bg-[var(--pos-bar)]" aria-hidden /> Market up
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px] bg-[var(--over)]" aria-hidden /> Market down
        </span>
      </div>
    </div>
  );
}
