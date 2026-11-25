/**
 * Users, sessions and PIN attempts (spec §2). The web app owns header trust and argon2 hashing; this module
 * only persists: users by Tailscale login, PIN hashes, 30-day sessions (sha256 of the cookie token only),
 * and the 5-failures-in-15-minutes lockout plus a per-IP limit.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { pinAttempts, sessions, users, type Db, type Session, type User } from "@homebase/db";
import { writeAudit } from "./audit";
import { withTx, type Ctx, type DbLike } from "./context";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { isAccentValue, type AccentValue } from "@homebase/shared";

export const SESSION_TTL_DAYS = 30;
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCKOUT_MINUTES = 15;
export const PIN_MAX_FAILURES_PER_IP = 20;

export type PublicUser = Omit<User, "passwordHash"> & { hasPassword: boolean };
const publicUser = ({ passwordHash, ...u }: User): PublicUser => ({ ...u, hasPassword: !!passwordHash });

export async function listUsers(db: DbLike): Promise<PublicUser[]> {
  return (await db.select().from(users).orderBy(asc(users.createdAt), asc(users.displayName))).map(publicUser);
}

export async function getUser(db: DbLike, id: string): Promise<PublicUser | null> {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  return u ? publicUser(u) : null;
}

/** Identify the caller from the `Tailscale-User-Login` header (case-insensitive). */
export async function getUserByTailscaleLogin(db: DbLike, login: string): Promise<PublicUser | null> {
  const [u] = await db.select().from(users).where(sql`lower(${users.tailscaleLogin}) = lower(${login.trim()})`);
  return u ? publicUser(u) : null;
}

export async function getUserByEmail(db: DbLike, email: string): Promise<PublicUser | null> {
  const [u] = await db.select().from(users).where(sql`lower(${users.email}) = lower(${email.trim()})`);
  return u ? publicUser(u) : null;
}

export async function getUserByUsername(db: DbLike, username: string): Promise<PublicUser | null> {
  const [u] = await db.select().from(users).where(sql`lower(${users.username}) = lower(${username.trim()})`);
  return u ? publicUser(u) : null;
}

/** The stored argon2 hash, for the web app to verify against. */
export async function getPasswordHash(db: DbLike, userId: string): Promise<string | null> {
  const [u] = await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, userId));
  if (!u) throw new NotFoundError("user", userId);
  return u.h;
}

/** Store (or clear) a password hash computed by the web app. Revokes the user's sessions when changed. */
export async function setPasswordHash(ctx: Ctx, userId: string, passwordHash: string | null): Promise<void> {
  await withTx(ctx, async (tx, c) => {
    const [u] = await tx.update(users).set({ passwordHash }).where(eq(users.id, userId)).returning({ id: users.id });
    if (!u) throw new NotFoundError("user", userId);
    await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    await writeAudit(tx, c, { action: passwordHash ? "user.set_password" : "user.clear_password", entity: "user", entityId: userId });
  });
}

/** Set a user's sign-in name: 2–32 letters, digits, dots, dashes or underscores, stored lowercase, unique. Audited. */
export async function setUsername(ctx: Ctx, userId: string, username: string): Promise<PublicUser> {
  const name = username.trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,32}$/.test(name)) throw new ValidationError("A username is 2 to 32 letters, numbers, dots, dashes or underscores.");
  return withTx(ctx, async (tx, c) => {
    const [taken] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.username}) = ${name} and ${users.id} <> ${userId}`);
    if (taken) throw new ConflictError(`Someone else already uses "${name}".`);
    const [before] = await tx.select({ username: users.username }).from(users).where(eq(users.id, userId));
    if (!before) throw new NotFoundError("user", userId);
    const [u] = await tx.update(users).set({ username: name }).where(eq(users.id, userId)).returning();
    await writeAudit(tx, c, { action: "user.set_username", entity: "user", entityId: userId, before: { username: before.username }, after: { username: name } });
    return publicUser(u!);
  });
}

/** Set (or clear, null = default blue) a user's UI accent: a named accent or a custom "#rrggbb". Audited, not undoable. */
export async function setUserAccent(ctx: Ctx, userId: string, accent: AccentValue | null): Promise<PublicUser> {
  if (accent !== null && !isAccentValue(accent)) throw new ValidationError(`invalid accent: ${String(accent)}`);
  return withTx(ctx, async (tx, c) => {
    const [before] = await tx.select({ accent: users.accent }).from(users).where(eq(users.id, userId));
    if (!before) throw new NotFoundError("user", userId);
    const [u] = await tx.update(users).set({ accent }).where(eq(users.id, userId)).returning();
    await writeAudit(tx, c, { action: "user.set_accent", entity: "user", entityId: userId, before: { accent: before.accent }, after: { accent } });
    return publicUser(u!);
  });
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Create a session; returns the raw cookie token (only its hash is stored). */
export async function createSession(db: DbLike, input: { userId: string; ip?: string | null; userAgent?: string | null; ttlDays?: number; now?: Date }): Promise<{ token: string; session: Session }> {
  const token = randomBytes(32).toString("base64url");
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (input.ttlDays ?? SESSION_TTL_DAYS) * 86_400_000);
  const [session] = await db
    .insert(sessions)
    .values({ userId: input.userId, tokenHash: hashToken(token), expiresAt, lastSeenAt: now, ip: input.ip ?? null, userAgent: input.userAgent ?? null })
    .returning();
  return { token, session: session! };
}

/** The live session and user for a cookie token, or null. Touches last_seen_at at most every 5 minutes. */
export async function getSession(db: DbLike, token: string, opts: { now?: Date } = {}): Promise<{ session: Session; user: PublicUser } | null> {
  const now = opts.now ?? new Date();
  const [row] = await db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)));
  if (!row) return null;
  if (!row.s.lastSeenAt || now.getTime() - row.s.lastSeenAt.getTime() > 5 * 60_000) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.s.id));
    row.s.lastSeenAt = now;
  }
  return { session: row.s, user: publicUser(row.u) };
}

/** Log out: deletes the session row for this token. */
export async function deleteSession(db: DbLike, token: string): Promise<boolean> {
  const rows = await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token))).returning({ id: sessions.id });
  return rows.length > 0;
}

export async function revokeUserSessions(db: DbLike, userId: string): Promise<number> {
  const rows = await db.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt))).returning({ id: sessions.id });
  return rows.length;
}

/** Records one attempt and returns its id. */
export async function recordPinAttempt(db: DbLike, input: { userId: string | null; ip: string; success: boolean; now?: Date }): Promise<string> {
  const [row] = await db
    .insert(pinAttempts)
    .values({ userId: input.userId, ip: input.ip, success: input.success, ...(input.now ? { createdAt: input.now, updatedAt: input.now } : {}) })
    .returning({ id: pinAttempts.id });
  return row!.id;
}

/**
 * Serializes PIN check-and-reserve across every process sharing the database (transaction-scoped
 * advisory lock, released at COMMIT/ROLLBACK). Held only for the lockout read + pending insert, never
 * across the slow argon2 verify. One lock for all users keeps the per-IP limit exact too; PIN sign-in
 * is rare enough that contention is irrelevant.
 */
export async function lockPinAttempts(tx: DbLike): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('homebase.pin_attempts'))`);
}

export type PinReservation = { ok: true; attemptId: string } | { ok: false; status: LockoutStatus };

/**
 * Check the lockout and, if allowed, record a PENDING attempt (stored as a failure) in one serialized
 * step, BEFORE the caller verifies the PIN. Concurrent attempts therefore each see the others'
 * pending rows, so a burst can't run more than PIN_MAX_FAILURES verifications before the lockout
 * trips. The caller flips the row with `completePinAttempt(…, true)` only when the PIN matched; a crash
 * mid-verify leaves it counted as a failure (fails closed).
 */
export async function reservePinAttempt(db: DbLike, input: { userId: string | null; ip: string; now?: Date }): Promise<PinReservation> {
  const now = input.now ?? new Date();
  return (db as Db).transaction(async (tx) => {
    await lockPinAttempts(tx);
    const status = await isLockedOut(tx, { userId: input.userId, ip: input.ip, now });
    if (status.locked) return { ok: false, status };
    return { ok: true, attemptId: await recordPinAttempt(tx, { userId: input.userId, ip: input.ip, success: false, now }) };
  });
}

/** Resolve a reserved attempt (only a match needs this; the pending row already counts as a failure). */
export async function completePinAttempt(db: DbLike, attemptId: string, success: boolean): Promise<void> {
  await db.update(pinAttempts).set({ success, updatedAt: new Date() }).where(eq(pinAttempts.id, attemptId));
}

export interface LockoutStatus {
  locked: boolean;
  reason: "user" | "ip" | null;
  /** When attempts are allowed again. */
  retryAt: Date | null;
  /** Failures counted in the current window (user, else IP). */
  failures: number;
}

/**
 * Locked when the user has ≥ 5 failures in the last 15 minutes since their last success, or the IP has
 * ≥ 20 failures in the last 15 minutes (any user).
 */
export async function isLockedOut(db: DbLike, input: { userId?: string | null; ip?: string | null; now?: Date }): Promise<LockoutStatus> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - PIN_LOCKOUT_MINUTES * 60_000);
  const windowMs = PIN_LOCKOUT_MINUTES * 60_000;
  if (input.userId) {
    const rows = await db
      .select({ success: pinAttempts.success, at: pinAttempts.createdAt })
      .from(pinAttempts)
      .where(and(eq(pinAttempts.userId, input.userId), gt(pinAttempts.createdAt, since)))
      .orderBy(desc(pinAttempts.createdAt));
    const failures: Date[] = [];
    for (const r of rows) {
      if (r.success) break;
      failures.push(r.at);
    }
    if (failures.length >= PIN_MAX_FAILURES) {
      const oldestCounted = failures[PIN_MAX_FAILURES - 1]!;
      return { locked: true, reason: "user", retryAt: new Date(oldestCounted.getTime() + windowMs), failures: failures.length };
    }
    if (!input.ip) return { locked: false, reason: null, retryAt: null, failures: failures.length };
  }
  if (input.ip) {
    const rows = await db
      .select({ at: pinAttempts.createdAt })
      .from(pinAttempts)
      .where(and(eq(pinAttempts.ip, input.ip), eq(pinAttempts.success, false), gt(pinAttempts.createdAt, since)))
      .orderBy(desc(pinAttempts.createdAt));
    if (rows.length >= PIN_MAX_FAILURES_PER_IP) {
      const oldest = rows[PIN_MAX_FAILURES_PER_IP - 1]!.at;
      return { locked: true, reason: "ip", retryAt: new Date(oldest.getTime() + windowMs), failures: rows.length };
    }
    return { locked: false, reason: null, retryAt: null, failures: rows.length };
  }
  return { locked: false, reason: null, retryAt: null, failures: 0 };
}
