import type { SpendingBreakdown, SpendingTrends } from "@homebase/core";

/** Donut slice colors, shared by the donut, its legend and the table swatches (server- and client-safe). */
export function sliceColors(data: Pick<SpendingBreakdown, "donut" | "rows">): Record<string, string> {
  const out: Record<string, string> = {};
  const inDonut = new Set(data.donut.map((d) => d.key));
  data.donut.forEach((d, i) => (out[d.key] = d.key === "other" ? "var(--chart-axis)" : `var(--chart-${(i % 8) + 1})`));
  for (const r of data.rows) if (!inDonut.has(r.key)) out[r.key] = r.amount > 0n ? "var(--chart-axis)" : "transparent";
  return out;
}

/** Stack colors for spending trends: the stacked series in order, the rest (folded into Other) gray. */
export function trendColors(data: Pick<SpendingTrends, "series" | "table">): Record<string, string> {
  const out: Record<string, string> = {};
  data.series.forEach((s, i) => (out[s.key] = s.key === "other" ? "var(--chart-axis)" : `var(--chart-${(i % 8) + 1})`));
  for (const r of data.table.rows) if (!out[r.key]) out[r.key] = "var(--chart-axis)";
  return out;
}
