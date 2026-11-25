import { NotFoundError, runSavedReport, toCsv, type Cell } from "@homebase/core";
import { getCurrentUser } from "@/server/auth";
import { getDb } from "@/server/db";

/** GET /reports/saved/<id>/export → a saved chart's data as CSV (values as charted: dollars or percent). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!(await getCurrentUser())) return new Response("Not signed in", { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  try {
    const r = await runSavedReport(getDb(), id);
    const c = r.chart;
    if (!c) return new Response("This saved report links to a built-in report; export it from there.", { status: 400 });
    let rows: Record<string, Cell>[];
    if (c.type === "table") rows = (c.rows ?? []).map((row) => Object.fromEntries((c.columns ?? []).map((col, i) => [col, row[i] ?? null])));
    else if (c.type === "sankey") rows = (c.links ?? []).map((l) => ({ source: l.source, target: l.target, value: l.value }));
    else {
      const xs = [...new Set((c.series ?? []).flatMap((s) => s.data.map((d) => String(d.x))))];
      rows = xs.map((x) => ({ [c.x ?? "x"]: x, ...Object.fromEntries((c.series ?? []).map((s) => [s.name, s.data.find((d) => String(d.x) === x)?.y ?? null])) }));
    }
    const slug = r.saved.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report";
    return new Response(toCsv(rows), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${slug}.csv"`, "Cache-Control": "no-store" },
    });
  } catch (e) {
    if (e instanceof NotFoundError) return new Response("Not found", { status: 404 });
    throw e;
  }
}
