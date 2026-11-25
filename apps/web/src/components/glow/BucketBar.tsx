"use client";
import { motion, useReducedMotion } from "motion/react";
import { cx } from "@/lib/cx";

export interface BarModel {
  state: "none" | "under" | "warn" | "over";
  /** Accent share 0..1 (what is left). */
  fill: number;
  /** Red share 0..1 (how far over). */
  over: number;
}

const SPRING = { type: "spring", stiffness: 140, damping: 22, mass: 0.9 } as const;

/**
 * The bucket bar. On mount it fills from 0 with a spring (staggered by `index`); an over-budget bar
 * first drains its accent fill, then the red overspend grows back in. Remount it (key) to replay.
 * Widths are percentages so the rounded ends never stretch; `data-fill` / `data-over` carry the targets.
 */
export function BucketBar({ bar, index = 0, height = 10, className, label }: { bar: BarModel; index?: number; height?: number; className?: string; label?: string }) {
  const reduce = useReducedMotion();
  const delay = 0.08 + Math.min(index, 14) * 0.035;
  const over = bar.state === "over";
  const fillTo = `${(bar.fill * 100).toFixed(2)}%`;
  const overTo = `${(bar.over * 100).toFixed(2)}%`;
  return (
    <div
      className={cx("hb-bar", className)}
      style={{ ["--bar-h" as string]: `${height}px` }}
      data-state={bar.state}
      data-fill={bar.fill}
      data-over={bar.over}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {bar.state !== "none" && (
        <motion.div
          className="hb-bar-fill"
          data-part="fill"
          initial={reduce ? false : { width: over ? "100%" : "0%" }}
          animate={{ width: over ? "0%" : fillTo }}
          transition={over ? { duration: 0.55, ease: [0.5, 0, 0.75, 0], delay } : { ...SPRING, delay }}
        />
      )}
      {over && (
        <motion.div
          className="hb-bar-over"
          data-part="over"
          initial={reduce ? false : { width: "0%" }}
          animate={{ width: overTo }}
          transition={{ ...SPRING, stiffness: 70, damping: 16, delay: delay + 0.5 }}
        />
      )}
    </div>
  );
}
