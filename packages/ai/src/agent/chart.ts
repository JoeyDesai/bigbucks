/**
 * `render_chart` spec (§11.3): {type, title, series, x, y, format}. The client renders it with
 * Recharts/ECharts. Values are plain numbers in dollars (or percent) — charting only, never
 * fed back into money math.
 */
import { z } from "zod";

export const CHART_TYPES = ["pie", "bar", "stacked_bar", "line", "area", "sankey", "table"] as const;

const Point = z.object({
  x: z.union([z.string().max(80), z.number()]).describe("Category label or ISO date"),
  y: z.number().describe("Value in dollars (currency) or percent (0-100)"),
});

const Series = z.object({
  name: z.string().min(1).max(80),
  data: z.array(Point).min(1).max(400),
});

const SankeyLink = z.object({ source: z.string().max(80), target: z.string().max(80), value: z.number().nonnegative() });

export const ChartSpecSchema = z
  .object({
    type: z.enum(CHART_TYPES),
    title: z.string().min(1).max(120),
    x: z.string().max(60).optional().describe("x-axis label, e.g. Month"),
    y: z.string().max(60).optional().describe("y-axis label, e.g. Spending"),
    format: z.enum(["currency", "percent", "number"]),
    series: z.array(Series).max(20).optional().describe("Required for pie/bar/stacked_bar/line/area. Pie uses one series."),
    links: z.array(SankeyLink).max(200).optional().describe("Required for sankey"),
    columns: z.array(z.string().max(60)).max(12).optional().describe("Required for table"),
    rows: z
      .array(z.array(z.union([z.string().max(120), z.number(), z.null()])).max(12))
      .max(200)
      .optional()
      .describe("Required for table; each row matches columns"),
  })
  .superRefine((spec, ctx) => {
    if (spec.type === "sankey") {
      if (!spec.links?.length) ctx.addIssue({ code: "custom", message: "sankey charts need links" });
    } else if (spec.type === "table") {
      if (!spec.columns?.length || !spec.rows) ctx.addIssue({ code: "custom", message: "table charts need columns and rows" });
      else if (spec.rows.some((r) => r.length !== spec.columns!.length)) ctx.addIssue({ code: "custom", message: "every table row must match columns" });
    } else {
      if (!spec.series?.length) ctx.addIssue({ code: "custom", message: `${spec.type} charts need series` });
      if (spec.type === "pie" && (spec.series?.length ?? 0) > 1) ctx.addIssue({ code: "custom", message: "pie charts take one series" });
      if (spec.type === "pie" && spec.series?.some((s) => s.data.some((p) => p.y < 0))) ctx.addIssue({ code: "custom", message: "pie values must be non-negative" });
    }
  });

export type ChartSpec = z.infer<typeof ChartSpecSchema>;
