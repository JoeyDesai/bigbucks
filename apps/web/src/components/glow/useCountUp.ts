"use client";
import { useEffect, useRef, useState } from "react";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Counts a bigint milli amount up from `from` (default 0) to `value` in whole cents with an expo
 * ease-out, then settles on the exact value. Re-runs when `value` or `key` changes (month switch).
 */
export function useCountUp(value: bigint, opts: { duration?: number; delay?: number; from?: bigint; key?: string } = {}): bigint {
  const { duration = 1100, delay = 0, key } = opts;
  const [frame, setFrame] = useState<{ to: bigint; v: bigint } | null>(() => ({ to: value, v: opts.from ?? 0n }));
  // what is on screen right now (survives Strict Mode's effect replay, so the count still runs in dev)
  const shownRef = useRef<bigint>(opts.from ?? 0n);
  useEffect(() => {
    const start = shownRef.current;
    const fromC = start / 10n;
    const delta = value / 10n - fromC;
    let raf = 0;
    if (prefersReducedMotion() || delta === 0n) {
      shownRef.current = value;
      raf = requestAnimationFrame(() => setFrame(null));
      return () => cancelAnimationFrame(raf);
    }
    let t0 = 0;
    const step = (t: number) => {
      if (!t0) t0 = t;
      const p = Math.min(1, Math.max(0, (t - t0 - delay) / duration));
      if (p >= 1) {
        shownRef.current = value;
        setFrame(null);
        return;
      }
      const eased = 1 - Math.pow(2, -10 * p);
      const v = (fromC + (delta * BigInt(Math.round(eased * 10000))) / 10000n) * 10n;
      shownRef.current = v;
      setFrame({ to: value, v });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, key]);
  return frame && frame.to === value ? frame.v : value;
}
