/**
 * §13 report 12: saved / custom reports. `saved_reports.spec` holds one of
 *  - an Ask chart (`ChartSpecSchema` from @homebase/ai, data inline, rendered as-is);
 *  - a reference to a built-in report: `{ report: "<slug>", params?: {…ReportParams} }`, run live;
 *  - the demo seed's provisional query shape `{ source: "v_transactions_flat", x, y, type, title, filters }`,
 *    run live as a spending query and returned as a chart spec.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ChartSpecSchema, type ChartSpec } from "@homebase/ai";
import { savedReports, type SavedReport } from "@homebase/db";
import { milliToNumber } from "@homebase/shared";
import { eq } from "drizzle-orm";
import type { Ctx, DbLike } from "../context";
import { NotFoundError } from "../errors";
import { listSavedReports, saveReport, updateSavedReport } from "../reports";
import { householdEntityId } from "../wealth/netWorth";
import { REPORT_SLUGS, ReportParamsPartialSchema, type ReportParams, type ReportSlug } from "./params";

export const SavedReportRefSchema = z.object({
  report: z.enum(REPORT_SLUGS).refine((s) => s !== "saved", "a saved report can't reference the saved-reports list"),
  params: ReportParamsPartialSchema.optional(),
});
export type SavedReportRef = z.infer<typeof SavedReportRefSchema>;

export const SavedQuerySpecSchema = z.object({
  source: z.literal("v_transactions_flat"),
  type: z.string().optional(),
  title: z.string().min(1).max(120),
  x: z.enum(["year", "month", "category", "group", "payee"]),
  y: z.string().optional(),
  format: z.string().optional(),
  filters: z.object({ category: z.string().optional(), group: z.string().optional(), payee: z.string().optional() }).optional(),
});
export type SavedQuerySpec = z.infer<typeof SavedQuerySpecSchema>;

export type ParsedSavedSpec =
  | { kind: "chart"; chart: ChartSpec }
  | { kind: "report"; report: Exclude<ReportSlug, "saved">; params: Partial<ReportParams> }
  | { kind: "query"; query: SavedQuerySpec }
  | { kind: "invalid"; error: string };

export function parseSavedSpec(spec: unknown): ParsedSavedSpec {
  const ref = SavedReportRefSchema.safeParse(spec);
  if (ref.success) return { kind: "report", report: ref.data.report as Exclude<ReportSlug, "saved">, params: ref.data.params ?? {} };
  const chart = ChartSpecSchema.safeParse(spec);
  if (chart.success) return { kind: "chart", chart: chart.data };
  const q = SavedQuerySpecSchema.safeParse(spec);
  if (q.success) return { kind: "query", query: q.data };
  return { kind: "invalid", error: chart.error.issues[0]?.message ?? "unrecognized report spec" };
}

export interface SavedReportItem {
  id: string;
  name: string;
  pinned: boolean;
  kind: ParsedSavedSpec["kind"];
  /** The referenced report slug (kind "report"). */
  report: string | null;
  /** Chart type for chart/query specs. */
  chartType: string | null;
  updatedAt: Date;
}

/** Saved reports, pinned first, with the spec kind resolved. */
export async function savedReportsIndex(db: DbLike): Promise<SavedReportItem[]> {
  const rows = await listSavedReports(db);
  return rows.map((r) => {
    const p = parseSavedSpec(r.spec);
    return {
      id: r.id,
      name: r.name,
      pinned: r.pinned,
      kind: p.kind,
      report: p.kind === "report" ? p.report : null,
      chartType: p.kind === "chart" ? p.chart.type : p.kind === "query" ? (p.query.type ?? "bar") : null,
      updatedAt: r.updatedAt,
    };
  });
}

export async function setSavedReportPinned(ctx: Ctx, id: string, pinned: boolean): Promise<SavedReport> {
  return updateSavedReport(ctx, id, { pinned });
}

/** Save a built-in report view (`{report, params}`) as a saved report. */
export async function saveReportView(ctx: Ctx, input: { name: string; report: Exclude<ReportSlug, "saved">; params: Partial<ReportParams>; pinned?: boolean }): Promise<SavedReport> {
  const { today: _today, ...params } = input.params;
  void _today;
  const spec = SavedReportRefSchema.parse({ report: input.report, params });
  return saveReport(ctx, { name: input.name, spec: spec as Record<string, unknown>, pinned: input.pinned ?? false });
}

export interface RunSavedReport {
  saved: SavedReport;
  parsed: ParsedSavedSpec;
  /** For chart and query specs. */
  chart: ChartSpec | null;
}

export async function getSavedReport(db: DbLike, id: string): Promise<SavedReport> {
  const [row] = await db.select().from(savedReports).where(eq(savedReports.id, id));
  if (!row) throw new NotFoundError("saved report", id);
  return row;
}

/**
 * Resolve a saved report. Chart specs come back as stored; query specs are run now. Report references
 * are returned parsed — run them with `runReport(db, parsed.report, params)`.
 */
export async function runSavedReport(db: DbLike, id: string): Promise<RunSavedReport> {
  const saved = await getSavedReport(db, id);
  const parsed = parseSavedSpec(saved.spec);
  if (parsed.kind === "chart") return { saved, parsed, chart: parsed.chart };
  if (parsed.kind === "query") return { saved, parsed, chart: await runSavedQuery(db, parsed.query) };
  return { saved, parsed, chart: null };
}

/** The seed's provisional query shape: household spending grouped by `x`, filtered by names. */
export async function runSavedQuery(db: DbLike, q: SavedQuerySpec): Promise<ChartSpec> {
  const hh = await householdEntityId(db);
  const conds = [
    sql`v.on_budget`,
    sql`NOT v.is_starting_balance`,
    sql`v.cleared <> 'pending'`,
    sql`v.category_kind IS DISTINCT FROM 'internal_rta'`,
    sql`NOT (v.is_transfer AND v.category_id IS NULL)`,
  ];
  if (hh) conds.push(sql`v.entity_id = ${hh}`);
  if (q.filters?.category) conds.push(sql`v.category_name = ${q.filters.category}`);
  if (q.filters?.group) conds.push(sql`v.group_name = ${q.filters.group}`);
  if (q.filters?.payee) conds.push(sql`v.payee_name = ${q.filters.payee}`);
  const x = {
    year: sql`to_char(v.date, 'YYYY')`,
    month: sql`v.month::text`,
    category: sql`coalesce(v.category_name, 'Uncategorized')`,
    group: sql`coalesce(v.group_name, 'Uncategorized')`,
    payee: sql`coalesce(v.payee_name, '(no payee)')`,
  }[q.x];
  const order = q.x === "year" || q.x === "month" ? sql`1 ASC` : sql`2 DESC`;
  const res = await db.execute<{ x: string; amount: bigint }>(sql`
    SELECT ${x} AS x, (-sum(v.amount_milli))::bigint AS amount FROM v_transactions_flat v
    WHERE ${sql.join(conds, sql` AND `)} GROUP BY 1 ORDER BY ${order} LIMIT 60`);
  const type = (["bar", "line", "area", "pie", "stacked_bar"] as const).find((t) => t === q.type) ?? "bar";
  const data = res.rows.map((r) => ({ x: r.x, y: milliToNumber(BigInt(r.amount)) }));
  return ChartSpecSchema.parse({
    type: type === "pie" && data.some((d) => d.y < 0) ? "bar" : type,
    title: q.title,
    x: q.x === "year" ? "Year" : q.x === "month" ? "Month" : q.x[0]!.toUpperCase() + q.x.slice(1),
    y: "Spending",
    format: "currency",
    series: [{ name: q.filters?.category ?? q.filters?.group ?? q.filters?.payee ?? "Spending", data: data.length ? data : [{ x: "—", y: 0 }] }],
  });
}
