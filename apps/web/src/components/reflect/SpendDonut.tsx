"use client";
import { motion, useReducedMotion } from "motion/react";
import type { Milli } from "@homebase/shared";
import { dollars, pct } from "@/lib/format";
import { slotColor, type Slice } from "@/lib/reflect";

const SIZE = 240;
const R = 112;
const RI = 76;
const C = SIZE / 2;

// rounded so the server and the browser print the same path (hydration)
const r2 = (v: number) => Math.round(v * 100) / 100;
function point(r: number, a: number): [number, number] {
  return [r2(C + r * Math.sin(a)), r2(C - r * Math.cos(a))];
}

/** An annular sector from angle a0 to a1 (radians, 0 = 12 o'clock, clockwise). */
function sector(a0: number, a1: number, r = R, ri = RI): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = point(r, a0);
  const [x1, y1] = point(r, a1);
  const [x2, y2] = point(ri, a1);
  const [x3, y3] = point(ri, a0);
  return `M${x0},${y0}A${r},${r} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${ri},${ri} 0 ${large} 0 ${x3},${y3}Z`;
}

/**
 * Spending by bucket as a ring: slices in the bucket's own color with a 2px surface gap, the hovered
 * slice lifts out, and the center names it (else the month's total).
 */
export function SpendDonut({
  slices,
  total,
  active,
  onActive,
  onSelect,
  monthLabel,
}: {
  slices: Slice[];
  total: Milli;
  active: string | null;
  onActive: (id: string | null) => void;
  onSelect: (id: string) => void;
  monthLabel: string;
}) {
  const reduce = useReducedMotion();
  const ends = slices.reduce<number[]>((acc, s) => [...acc, (acc.at(-1) ?? 0) + s.share * Math.PI * 2], []);
  const arcs = slices.map((s, k) => ({ s, a0: ends[k - 1] ?? 0, a1: ends[k]! }));
  const hot = active ? slices.find((s) => s.id === active) : null;
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[260px]" onPointerLeave={() => onActive(null)}>
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="h-full w-full overflow-visible"
        role="img"
        aria-label={`Spending by bucket, ${monthLabel}: ${slices.map((s) => `${s.name} ${dollars(s.value)}`).join(", ")}`}
      >
        {slices.length === 0 && <circle cx={C} cy={C} r={(R + RI) / 2} fill="none" stroke="var(--chart-grid)" strokeWidth={R - RI} />}
        {arcs.map(({ s, a0, a1 }, i) => {
          const full = a1 - a0 >= Math.PI * 2 - 1e-6;
          const on = active === s.id;
          const mid = (a0 + a1) / 2;
          const [dx, dy] = on ? [Math.sin(mid) * 6, -Math.cos(mid) * 6] : [0, 0];
          return (
            <motion.path
              key={s.id}
              d={full ? sector(0, Math.PI * 2 - 1e-4) : sector(a0, a1)}
              fill={slotColor(s.slot)}
              stroke="var(--paper-raised)"
              strokeWidth={2}
              strokeLinejoin="round"
              initial={reduce ? false : { opacity: 0, scale: 0.92 }}
              animate={{ opacity: active && !on ? 0.45 : 1, scale: 1, x: dx, y: dy }}
              transition={{ delay: reduce ? 0 : 0.05 + i * 0.05, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              style={{ transformOrigin: `${C}px ${C}px` }}
              className="cursor-pointer"
              onPointerEnter={() => onActive(s.id)}
              onClick={() => onSelect(s.id)}
              data-slice={s.id}
            />
          );
        })}
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-12 text-center" aria-live="polite">
        <div className="max-w-full truncate text-[12.5px] font-medium text-ink-3">{hot ? hot.name : `Spent in ${monthLabel}`}</div>
        <div className="num display mt-0.5 text-[28px] leading-none text-ink">{dollars(hot ? hot.value : total)}</div>
        {hot && <div className="num mt-1 text-[12.5px] text-ink-3">{pct(hot.share)} of spending</div>}
      </div>
    </div>
  );
}
