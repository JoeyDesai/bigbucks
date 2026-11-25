import "server-only";
import { eq, sql } from "drizzle-orm";
import { users, type Db } from "@homebase/db";
import type { CurrentUser } from "@/server/auth";

export interface DbUserRef {
  /** users.id in Postgres (what audit_log, ai_conversations and push_subscriptions reference). */
  id: string;
  displayName: string;
  role: "admin" | "member";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Map the signed-in identity to its `users` row. The identity layer may still be the in-memory
 * store (ids like "usr_alex"), so match by id, then Tailscale login, then display name.
 * Returns null when the household has no matching DB user (fresh DB without a seed).
 */
export async function resolveDbUser(db: Db, cu: CurrentUser): Promise<DbUserRef | null> {
  const u = cu.user;
  const pick = (r: { id: string; displayName: string; role: "admin" | "member" } | undefined) => (r ? { id: r.id, displayName: r.displayName, role: r.role } : null);
  const cols = { id: users.id, displayName: users.displayName, role: users.role };
  if (UUID.test(u.id)) {
    const [r] = await db.select(cols).from(users).where(eq(users.id, u.id));
    if (r) return pick(r);
  }
  if (u.tailscaleLogin) {
    const [r] = await db.select(cols).from(users).where(sql`lower(${users.tailscaleLogin}) = lower(${u.tailscaleLogin})`);
    if (r) return pick(r);
  }
  const [r] = await db.select(cols).from(users).where(sql`lower(${users.displayName}) = lower(${u.displayName})`);
  return pick(r);
}

/** Like resolveDbUser but throws a readable error (for actions that must write audit rows). */
export async function requireDbUser(db: Db, cu: CurrentUser): Promise<DbUserRef> {
  const r = await resolveDbUser(db, cu);
  if (!r) throw new Error(`No database user matches ${cu.user.displayName}. Run the seed or the first-run setup.`);
  return r;
}
