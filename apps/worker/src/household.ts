/** Household users for `setup:household` (spec §2): upsert by Tailscale login with a default accent. */
import { sql } from "drizzle-orm";
import { users, type Tx } from "@homebase/db";
import type { UserAccent } from "@homebase/shared";

export const DEFAULT_ACCENT: Record<"admin" | "member", UserAccent> = { admin: "gold", member: "pink" };

export interface HouseholdPerson {
  login: string;
  name: string;
  role: "admin" | "member";
  /** Explicit accent; omitted = keep the user's accent, or the role default when they have none. */
  accent?: UserAccent;
}

/** Upsert users by Tailscale login (PINs untouched). */
export async function upsertHouseholdUsers(tx: Tx, people: HouseholdPerson[]): Promise<void> {
  for (const p of people) {
    const fallback = DEFAULT_ACCENT[p.role];
    await tx
      .insert(users)
      .values({ tailscaleLogin: p.login.toLowerCase(), displayName: p.name, role: p.role, accent: p.accent ?? fallback })
      .onConflictDoUpdate({
        target: users.tailscaleLogin,
        set: { displayName: p.name, role: p.role, accent: p.accent ?? sql`coalesce(${users.accent}, ${fallback})`, updatedAt: new Date() },
      });
  }
}
