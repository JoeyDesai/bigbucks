"use client";
import { useId } from "react";
import { cx } from "@/lib/cx";
import { monotonePath, thin } from "./path";

/** Tiny accent sparkline with a soft glow and an area wash; draws itself in once. */
export function Sparkline({ values, width = 120, height = 32, className, tone = "accent" }: { values: number[]; width?: number; height?: number; className?: string; tone?: "accent" | "over" }) {
  const id = useId().replace(/:/g, "");
  const vs = thin(values, 80);
  if (vs.length < 2) return <svg width={width} height={height} aria-hidden className={className} />;
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const span = max - min || 1;
  const pad = 3;
  const pts = vs.map((v, i) => ({ x: (i / (vs.length - 1)) * width, y: pad + (1 - (v - min) / span) * (height - pad * 2) }));
  const line = monotonePath(pts);
  const area = `${line}L${width},${height}L0,${height}Z`;
  const color = tone === "over" ? "var(--over)" : "var(--accent)";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className={cx("overflow-visible", className)}>
      <defs>
        <linearGradient id={`sg${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#sg${id})`} style={{ animation: "hb-fade-in 900ms var(--ease-out-quart) both" }} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.75}
        strokeLinecap="round"
        pathLength={1}
        strokeDasharray="1 1"
        style={{ filter: `drop-shadow(0 0 4px ${tone === "over" ? "var(--over-glow)" : "var(--accent-glow)"})`, animation: "hb-draw 1100ms var(--ease-out-expo) both" }}
      />
    </svg>
  );
}
