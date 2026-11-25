import "server-only";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { pinAttempts, sessions, type Db } from "@homebase/db";
import { completePinAttempt, getPasswordHash, getUser, getUserByEmail, getUserByTailscaleLogin, getUserByUsername, listUsers, lockPinAttempts, setPasswordHash, userCtx, type DbLike } from "@homebase/core";
import { isAccentValue } from "@homebase/shared";
import type { IdentityStores, PinAttempt, PinAttemptSnapshot, PinAttemptStore, PinReservation, Session, SessionStore, User, UserStore } from "./types";

/**
 * Postgres-backed identity stores (tables `users`, `sessions`, `pin_attempts`). User reads go through
 * @homebase/core; sessions store only sha256(token); sign-in attempts feed the lockout policy in
 * `pin-policy.ts`.
 */
class DbUserStore implements UserStore {
  constructor(private db: Db) {}
  private async withHash(u: { id: string; displayName: string; tailscaleLogin: string | null; email?: string | null; username?: string | null; role: "admin" | "member"; accent?: string | null } | null): Promise<User | null> {
    if (!u) return null;
    return { id: u.id, displayName: u.displayName, tailscaleLogin: u.tailscaleLogin, email: u.email ?? null, username: u.username ?? null, role: u.role, accent: isAccentValue(u.accent) ? u.accent : null, passwordHash: await getPasswordHash(this.db, u.id) };
  }
  async list() {
    const all = await listUsers(this.db);
    return Promise.all(all.map((u) => this.withHash(u) as Promise<User>));
  }
  async getById(id: string) {
    return this.withHash(await getUser(this.db, id));
  }
  async getByTailscaleLogin(login: string) {
    return this.withHash(await getUserByTailscaleLogin(this.db, login));
  }
  async getByUsername(username: string) {
    return this.withHash(await getUserByUsername(this.db, username));
  }
  async getByEmail(email: string) {
    return this.withHash(await getUserByEmail(this.db, email));
  }
  async setPasswordHash(userId: string, passwordHash: string | null) {
    await setPasswordHash(userCtx(this.db, userId), userId, passwordHash);
  }
}

class DbSessionStore implements SessionStore {
  constructor(private db: Db) {}
  async create(s: Session) {
    await this.db.insert(sessions).values({ userId: s.userId, tokenHash: s.tokenHash, expiresAt: s.expiresAt, lastSeenAt: s.createdAt, ip: s.ip, userAgent: s.userAgent });
  }
  async get(tokenHash: string) {
    const [r] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));
    if (!r) return null;
    return { tokenHash: r.tokenHash, userId: r.userId, createdAt: r.createdAt, expiresAt: r.expiresAt, ip: r.ip, userAgent: r.userAgent };
  }
  async delete(tokenHash: string) {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  }
  async deleteForUser(userId: string) {
    await this.db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
  }
}

class DbPinAttemptStore implements PinAttemptStore {
  constructor(private db: Db) {}
  /**
   * Lockout read + pending insert under a transaction-scoped advisory lock (`lockPinAttempts`), so
   * concurrent requests in any process serialize here and each sees the others' pending rows. The
   * lock is released at COMMIT, before the caller runs argon2.
   */
  async reserve<V>(
    input: { userId: string | null; ip: string; at: Date; userSince: Date; ipSince: Date },
    gate: (seen: PinAttemptSnapshot) => V | null,
  ): Promise<PinReservation<V>> {
    return this.db.transaction(async (tx): Promise<PinReservation<V>> => {
      await lockPinAttempts(tx);
      const history = input.userId ? await recent(tx, input.userId, input.userSince) : [];
      const veto = gate({ history, ipCount: await countIp(tx, input.ip, input.ipSince) });
      if (veto !== null) return { ok: false, veto };
      const [row] = await tx
        .insert(pinAttempts)
        .values({ userId: input.userId, ip: input.ip, success: false, createdAt: input.at, updatedAt: input.at })
        .returning({ id: pinAttempts.id });
      return { ok: true, id: row!.id, history };
    });
  }
  async complete(id: string, success: boolean) {
    await completePinAttempt(this.db, id, success);
  }
  async record(a: PinAttempt) {
    await this.db.insert(pinAttempts).values({ userId: a.userId, ip: a.ip, success: a.success, createdAt: a.at, updatedAt: a.at });
  }
  async recentForUser(userId: string, since: Date) {
    return recent(this.db, userId, since);
  }
  async countForIp(ip: string, since: Date) {
    return countIp(this.db, ip, since);
  }
}

async function recent(db: DbLike, userId: string, since: Date): Promise<PinAttempt[]> {
  const rows = await db
    .select()
    .from(pinAttempts)
    .where(and(eq(pinAttempts.userId, userId), gte(pinAttempts.createdAt, since)))
    .orderBy(desc(pinAttempts.createdAt));
  return rows.map((r) => ({ userId: r.userId, ip: r.ip, success: r.success, at: r.createdAt }));
}

async function countIp(db: DbLike, ip: string, since: Date): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(pinAttempts).where(and(eq(pinAttempts.ip, ip), gte(pinAttempts.createdAt, since)));
  return r?.n ?? 0;
}

export function createDbStores(db: Db): IdentityStores {
  return { users: new DbUserStore(db), sessions: new DbSessionStore(db), pinAttempts: new DbPinAttemptStore(db) };
}
