import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/server/db";

export const dynamic = "force-dynamic";

/** Liveness + DB probe for deploy.sh / compose healthcheck. Public; reveals nothing beyond up/down. */
export async function GET() {
  let db = false;
  try {
    await getDb().execute(sql`SELECT 1`);
    db = true;
  } catch {
    db = false;
  }
  return NextResponse.json({ ok: db, service: "homebase-web", db, at: new Date().toISOString() }, { status: db ? 200 : 503 });
}
