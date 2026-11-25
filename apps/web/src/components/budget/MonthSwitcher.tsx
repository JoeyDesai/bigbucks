"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { addMonths, formatMonth, type Month } from "@homebase/shared";
import { cx } from "@/lib/cx";

export interface MonthSwitcherProps {
  month: Month;
  /** History-routed links (preferred): returns the href for a month. */
  hrefFor?: (month: Month) => string;
  /** Or a callback for client-side state. */
  onChange?: (month: Month) => void;
  /** The real current month; shows a "Today" jump when away from it. */
  currentMonth?: Month;
  min?: Month;
  max?: Month;
  className?: string;
  /** Smaller variant for phones. */
  compact?: boolean;
}

const NAV_BTN =
  "inline-flex h-8 w-8 items-center justify-center rounded-full border border-rule-strong text-ink-2 transition-colors hover:border-accent hover:text-accent aria-disabled:pointer-events-none aria-disabled:opacity-30";
const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** YNAB month switcher: ‹ › circle buttons around "Oct 2026 ▾"; the caret opens a month grid. */
export function MonthSwitcher({ month, hrefFor, onChange, currentMonth, min, max, className, compact }: MonthSwitcherProps) {
  const prev = addMonths(month, -1);
  const next = addMonths(month, 1);
  const prevDisabled = !!min && prev < min;
  const nextDisabled = !!max && next > max;
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(Number(month.slice(0, 4)));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const go = (target: Month, disabled: boolean, label: string, content: React.ReactNode, cls: string) =>
    hrefFor ? (
      <Link href={hrefFor(target)} aria-label={label} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined} className={cls} scroll={false} onClick={() => setOpen(false)}>
        {content}
      </Link>
    ) : (
      <button
        type="button"
        aria-label={label}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        onClick={() => {
          setOpen(false);
          onChange?.(target);
        }}
        className={cls}
      >
        {content}
      </button>
    );

  return (
    <div ref={ref} className={cx("relative flex items-center gap-2", className)}>
      {go(prev, prevDisabled, `Previous month, ${formatMonth(prev)}`, <ChevronLeft size={18} strokeWidth={2.2} />, NAV_BTN)}
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setYear(Number(month.slice(0, 4)));
          setOpen((v) => !v);
        }}
        className="inline-flex items-center gap-1 rounded-md px-1 text-ink hover:text-accent"
      >
        <span className={cx("whitespace-nowrap font-bold leading-none", compact ? "text-[19px]" : "text-[22px]")} aria-live="polite">
          {formatMonth(month, "short")}
        </span>
        <ChevronDown size={16} strokeWidth={2.4} aria-hidden className="text-ink-3" />
      </button>
      {go(next, nextDisabled, `Next month, ${formatMonth(next)}`, <ChevronRight size={18} strokeWidth={2.2} />, NAV_BTN)}
      {currentMonth && currentMonth !== month && go(currentMonth, false, `Back to ${formatMonth(currentMonth)}`, "Today", "ml-1 rounded-full border border-rule-strong px-3 py-1 text-[13px] font-semibold text-accent hover:border-accent")}
      {open && (
        <div role="dialog" aria-label="Choose a month" className="absolute left-0 top-full z-40 mt-2 w-[260px] rounded-xl border border-rule bg-paper-raised p-3 shadow-pop" style={{ animation: "hb-pop 140ms var(--ease-out-quart)" }}>
          <div className="mb-2 flex items-center justify-between">
            <button type="button" aria-label="Previous year" onClick={() => setYear((y) => y - 1)} className={NAV_BTN}>
              <ChevronLeft size={16} strokeWidth={2.2} />
            </button>
            <span className="num text-[15px] font-bold">{year}</span>
            <button type="button" aria-label="Next year" onClick={() => setYear((y) => y + 1)} className={NAV_BTN}>
              <ChevronRight size={16} strokeWidth={2.2} />
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1">
            {SHORT.map((label, i) => {
              const m = `${year}-${String(i + 1).padStart(2, "0")}-01` as Month;
              const disabled = (!!min && m < min) || (!!max && m > max);
              const here = m === month;
              return (
                <span key={label}>
                  {go(
                    m,
                    disabled,
                    formatMonth(m),
                    label,
                    cx(
                      "flex h-9 items-center justify-center rounded-lg text-[13.5px] font-semibold aria-disabled:pointer-events-none aria-disabled:opacity-30",
                      here ? "bg-accent text-accent-contrast" : m === currentMonth ? "text-accent ring-1 ring-accent" : "text-ink-2 hover:bg-accent-soft",
                    ),
                  )}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
