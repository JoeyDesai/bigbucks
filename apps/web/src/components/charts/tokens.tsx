"use client";
import { createContext, useContext, useEffect, useState, type RefObject } from "react";

export interface ChartTokens {
  series: string[];
  grid: string;
  axis: string;
  ink: string;
  ink2: string;
  paper: string;
  rule: string;
  pos: string;
  neg: string;
  warn: string;
  font: string;
}

const FALLBACK: ChartTokens = {
  series: ["#2c4a78", "#b07a1e", "#4f7a5a", "#a64b36", "#6c5a8c", "#3f7f86", "#8c6b4f", "#7a7f3a"],
  grid: "#e2dbcd",
  axis: "#8a8377",
  ink: "#1d1b18",
  ink2: "#57524a",
  paper: "#f5f1e8",
  rule: "#ddd5c5",
  pos: "#1f6a45",
  neg: "#ad2a1f",
  warn: "#8c5a00",
  font: "system-ui, sans-serif",
};

function read(el: Element): ChartTokens {
  const cs = getComputedStyle(el);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  return {
    series: FALLBACK.series.map((fb, i) => v(`--chart-${i + 1}`, fb)),
    grid: v("--chart-grid", FALLBACK.grid),
    axis: v("--chart-axis", FALLBACK.axis),
    ink: v("--ink", FALLBACK.ink),
    ink2: v("--ink-2", FALLBACK.ink2),
    paper: v("--paper", FALLBACK.paper),
    rule: v("--rule", FALLBACK.rule),
    pos: v("--pos-bar", FALLBACK.pos),
    neg: v("--neg-bar", FALLBACK.neg),
    warn: v("--warn-bar", FALLBACK.warn),
    font: cs.fontFamily || FALLBACK.font,
  };
}

/**
 * Reads chart colors from CSS tokens on `ref` (so a scoped data-theme works) and re-reads
 * when the theme changes (data-theme attribute anywhere above, or the OS color scheme).
 */
export function useChartTokens(ref: RefObject<Element | null>): ChartTokens {
  const [tokens, setTokens] = useState<ChartTokens>(FALLBACK);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setTokens(read(el));
    update();
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"], subtree: true });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", update);
    return () => {
      mo.disconnect();
      mq.removeEventListener("change", update);
    };
  }, [ref]);
  return tokens;
}

export const ChartTokensContext = createContext<ChartTokens>(FALLBACK);
export const useChartTheme = () => useContext(ChartTokensContext);
