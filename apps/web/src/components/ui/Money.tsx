"use client";
import { useEffect, useRef, useState } from "react";
import { formatMilli } from "@homebase/shared";
import { cx } from "@/lib/cx";
import type { Tone } from "@/lib/budget-display";

export type MoneyTone = Tone | "auto" | "signed" | "inherit";

export interface MoneyProps {
  /** bigint milliunits. */
  value: bigint;
  /**
   * "auto" (default): ink, zero muted. "signed": green > 0, red < 0, gray 0.
   * Or an explicit tone: pos | neg | warn | zero | ink | muted.
   */
  tone?: MoneyTone;
  sign?: "auto" | "always" | "never";
  cents?: boolean;
  /** Bold headline weight (big numbers). */
  display?: boolean;
  /** Animate a quick count from the previous value when `value` changes. */
  animate?: boolean;
  className?: string;
  /** Accessible label override, e.g. "Available". Prepended to the spoken amount. */
  label?: string;
}

const TONE_CLASS: Record<Tone, string> = {
  pos: "text-pos",
  neg: "text-neg",
  warn: "text-warn",
  zero: "text-zero",
  ink: "text-ink",
  muted: "text-ink-3",
};

export function moneyToneClass(value: bigint, tone: MoneyTone = "auto"): string {
  if (tone === "inherit") return "";
  if (tone === "auto") return value === 0n ? TONE_CLASS.zero : TONE_CLASS.ink;
  if (tone === "signed") return value > 0n ? TONE_CLASS.pos : value < 0n ? TONE_CLASS.neg : TONE_CLASS.zero;
  return TONE_CLASS[tone];
}

const TICK_MS = 380;

/** Interpolates in whole cents (display only; when idle it renders the exact bigint). */
function useTickingValue(value: bigint, animate: boolean): bigint {
  // A frame is only shown while it belongs to the current target value.
  const [frame, setFrame] = useState<{ to: bigint; v: bigint } | null>(null);
  const prev = useRef(value);
  useEffect(() => {
    const from = prev.current;
    prev.current = value;
    if (!animate || from === value || typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const start = performance.now();
    const fromC = from / 10n;
    const delta = value / 10n - fromC;
    let raf = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / TICK_MS);
      if (p >= 1) {
        setFrame(null);
        return;
      }
      const eased = 1 - Math.pow(1 - p, 4);
      setFrame({ to: value, v: (fromC + (delta * BigInt(Math.round(eased * 1000))) / 1000n) * 10n });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, animate]);
  return frame && frame.to === value ? frame.v : value;
}

/** Formatted money with tabular numerals, semantic color and optional tick animation. */
export function Money({ value, tone = "auto", sign = "auto", cents = true, display, animate, className, label }: MoneyProps) {
  const shown = useTickingValue(value, !!animate);
  const text = formatMilli(shown, { sign, cents });
  const finalText = formatMilli(value, { sign, cents });
  return (
    <span
      className={cx("num whitespace-nowrap", display && "display", moneyToneClass(value, tone), className)}
      aria-label={label ? `${label} ${finalText}` : undefined}
      data-value={value.toString()}
    >
      {text}
    </span>
  );
}
