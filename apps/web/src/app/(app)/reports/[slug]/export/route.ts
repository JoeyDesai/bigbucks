import { NotFoundError, ValidationError, isRunnableReport, paramsFromSearch, reportDefaults, runReport, toCsv } from "@homebase/core";
import { today } from "@homebase/shared";
import { getCurrentUser } from "@/server/auth";
import { getDb } from "@/server/db";

/** GET /reports/<slug>/export?<report params> → the report's table as CSV. */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  if (!(await getCurrentUser())) return new Response("Not signed in", { status: 401 });
  const { slug } = await params;
  if (!isRunnableReport(slug)) return new Response("Unknown report", { status: 404 });
  const p = paramsFromSearch(new URL(req.url).searchParams, { ...reportDefaults(slug), today: today() });
  try {
    const data = await runReport(getDb(), slug, p);
    const name = `${slug}-${data.period.from}-to-${data.period.to}${p.entity === "household" ? "" : `-${p.entity}`}.csv`;
    return new Response(toCsv(data.table), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof ValidationError || e instanceof NotFoundError) return new Response(e.message, { status: 400 });
    throw e;
  }
}
