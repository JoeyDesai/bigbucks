import "server-only";
import { getCurrentUser, type CurrentUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { resolveDbUser, type DbUserRef } from "@/server/settings/dbUser";

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** Signed-in user for an API route, mapped to the users row; a Response when not allowed. */
export async function apiUser(opts: { admin?: boolean } = {}): Promise<{ cu: CurrentUser; user: DbUserRef } | Response> {
  const cu = await getCurrentUser();
  if (!cu) return json({ error: "unauthenticated" }, 401);
  // Admin-only endpoints answer 404 to members, like the pages (§2).
  if (opts.admin && cu.user.role !== "admin") return json({ error: "not_found" }, 404);
  const user = await resolveDbUser(getDb(), cu);
  if (!user) return json({ error: "no_user", message: "No household user matches this sign-in." }, 403);
  return { cu, user };
}

/** Same-origin check for state-changing requests (defense in depth on top of SameSite cookies). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
