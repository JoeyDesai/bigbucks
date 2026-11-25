"use client";
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "@/lib/cx";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  /** Optional count shown after the label in muted numerals. */
  count?: number;
  /** Chips only: a leading icon and a semantic tint ("neg" = red chip, e.g. Overspent). */
  icon?: ReactNode;
  tone?: "neg" | "warn";
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group. */
  label: string;
  /** "segmented": iOS-style pill control. "underline": text tabs with an accent rule. "chips": YNAB filter chips (scroll horizontally). */
  variant?: "segmented" | "underline" | "chips";
  size?: "sm" | "md";
  className?: string;
  /** Stretch segments to fill the width (segmented only). */
  block?: boolean;
}

/** Radio-group semantics with roving tabindex and arrow-key navigation (segments, tabs or filter chips). */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  variant = "segmented",
  size = "md",
  className,
  block,
}: SegmentedControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.filter((o) => !o.disabled);

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, idx: number) {
    const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const current = enabled.findIndex((o) => o.value === options[idx]!.value);
    let next = current;
    if (e.key === "ArrowRight") next = (current + 1) % enabled.length;
    if (e.key === "ArrowLeft") next = (current - 1 + enabled.length) % enabled.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = enabled.length - 1;
    const opt = enabled[next]!;
    onChange(opt.value);
    refs.current[options.indexOf(opt)]?.focus();
    refs.current[options.indexOf(opt)]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  if (variant === "underline") {
    return (
      <div
        role="radiogroup"
        aria-label={label}
        className={cx("scrollbar-none flex gap-5 overflow-x-auto border-b border-rule", className)}
      >
        {options.map((o, i) => {
          const active = o.value === value;
          return (
            <button
              key={o.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              disabled={o.disabled}
              onClick={() => onChange(o.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cx(
                "relative -mb-px shrink-0 whitespace-nowrap border-b-2 pb-2.5 pt-2 transition-colors",
                size === "sm" ? "min-h-10 text-[13px]" : "min-h-11 text-[14px]",
                active ? "border-accent font-semibold text-ink" : "border-transparent font-medium text-ink-3 hover:text-ink-2",
              )}
            >
              {o.label}
              {o.count !== undefined && <span className={cx("num ml-1.5", active ? "text-ink-2" : "text-ink-3")}>{o.count}</span>}
            </button>
          );
        })}
      </div>
    );
  }

  if (variant === "chips") {
    return (
      <div role="radiogroup" aria-label={label} className={cx("scrollbar-none flex gap-2 overflow-x-auto py-0.5", className)}>
        {options.map((o, i) => {
          const active = o.value === value;
          const toned = o.tone && (o.count ?? 0) > 0;
          return (
            <button
              key={o.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              disabled={o.disabled}
              onClick={() => onChange(o.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cx(
                "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 font-semibold transition-colors",
                size === "sm" ? "min-h-8 text-[13px]" : "min-h-9 text-[13.5px]",
                active
                  ? "border-accent bg-accent-soft text-accent"
                  : toned && o.tone === "neg"
                    ? "border-transparent bg-neg-wash text-neg hover:border-neg/40"
                    : toned && o.tone === "warn"
                      ? "border-transparent bg-warn-wash text-warn hover:border-warn/40"
                      : "border-rule bg-paper-raised text-ink-2 hover:border-rule-strong hover:text-ink",
              )}
            >
              {o.icon}
              {o.count !== undefined && <span className="num">{o.count}</span>}
              {o.label}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx("inline-flex rounded-lg bg-track p-0.5", block && "flex w-full", className)}
    >
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cx(
              "whitespace-nowrap rounded-md px-3 font-semibold transition-colors duration-150",
              size === "sm" ? "min-h-8 text-[12px]" : "min-h-10 text-[13px]",
              block && "flex-1",
              active ? "bg-paper-raised text-ink shadow-[0_1px_3px_rgba(20,22,60,0.14)]" : "text-ink-3 hover:text-ink",
            )}
          >
            {o.label}
            {o.count !== undefined && <span className="num ml-1.5 opacity-70">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
