"use client";
import { useRef, type ReactNode } from "react";
import { cx } from "@/lib/cx";
import { ChartTokensContext, useChartTokens } from "./tokens";

export interface ChartFrameProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned controls (period SegmentedControl, save-as-report…). */
  actions?: ReactNode;
  /** Plot height in px. */
  height?: number;
  children: ReactNode;
  /** Accessible summary of what the chart shows (charts are aria-hidden visuals). */
  summary: string;
  footer?: ReactNode;
  className?: string;
}

/** Frame for every chart: serif title, controls, fixed-height plot, token colors via context. */
export function ChartFrame({ title, subtitle, actions, height = 240, children, summary, footer, className }: ChartFrameProps) {
  const ref = useRef<HTMLElement>(null);
  const tokens = useChartTokens(ref);
  return (
    <figure ref={ref} className={cx("min-w-0", className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            {title && <figcaption className="display text-[20px] leading-tight text-ink">{title}</figcaption>}
            {subtitle && <p className="mt-0.5 text-[13px] text-ink-3">{subtitle}</p>}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </div>
      )}
      <ChartTokensContext.Provider value={tokens}>
        <div role="img" aria-label={summary} style={{ height }} className="relative w-full min-w-0">
          {children}
        </div>
        {footer && <div className="mt-3">{footer}</div>}
      </ChartTokensContext.Provider>
    </figure>
  );
}
