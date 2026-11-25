import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import argon2 from "argon2";
import { env } from "./env";
import { log } from "./log";
import { getIdentityStores } from "./identity/stores";
import { ACCESS_EMAIL_HEADER, SESSION_COOKIE, TRUSTED_HEADER, lastForwardedHop } from "./identity/header-trust";
import { FAILURE_MEMORY_MS, IP_WINDOW_MS, isIpRateLimited, isValidPasswordFormat, lockoutUntil, minutesUntil, remainingBeforeLockout } from "./identity/pin-policy";
import type { Role, User } from "./identity/types";

export type { Role, User };
export type AuthMethod = "access" | "tailscale" | "session" | "dev" | "demo";
export interface CurrentUser {
  user: User;
  via: AuthMethod;
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Client IP as seen by the app. Behind Serve, the last XFF hop is the caller's tailnet IP. */
export async function requestIp(): Promise<string> {
  const h = await headers();
  return lastForwardedHop(h.get("x-forwarded-for")) ?? "unknown";
}

let devPasswordApplied = false;
async function applyDevPassword(): Promise<void> {
  const e = env();
  if (devPasswordApplied || e.NODE_ENV === "production" || !e.HOMEBASE_DEV_PASSWORD) return;
  devPasswordApplied = true;
  const { users } = getIdentityStores();
  const hash = await argon2.hash(e.HOMEBASE_DEV_PASSWORD, { type: argon2.argon2id });
  for (const u of await users.list()) if (!u.passwordHash) await users.setPasswordHash(u.id, hash);
}

/**
 * Resolve the signed-in user for this request (memoized per request).
 * Order: verified Cloudflare Access email → trusted Tailscale header → session cookie → public demo (HOMEBASE_DEMO=1:
 * everyone is the sample household's admin) → dev bypass (NODE_ENV=development only).
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const { users, sessions } = getIdentityStores();
  const h = await headers();

  const email = h.get(ACCESS_EMAIL_HEADER);
  if (email) {
    const user = await users.getByEmail(email);
    if (user) return { user, via: "access" };
  }

  if (h.get(TRUSTED_HEADER) === "1") {
    const login = h.get("tailscale-user-login");
    if (login) {
      const user = await users.getByTailscaleLogin(login);
      if (user) return { user, via: "tailscale" };
    }
  }

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) {
    const s = await sessions.get(hashToken(token));
    if (s && s.expiresAt > new Date()) {
      const user = await users.getById(s.userId);
      if (user) return { user, via: "session" };
    }
  }

  const e = env();
  if (e.HOMEBASE_DEMO === "1") {
    const user = (await users.list()).find((u) => u.role === "admin");
    if (user) return { user, via: "demo" };
  }
  if (e.NODE_ENV === "development" && e.HOMEBASE_DEV_USER) {
    const user = await users.getByTailscaleLogin(e.HOMEBASE_DEV_USER);
    if (user) return { user, via: "dev" };
  }
  return null;
});

export async function requireUser(): Promise<CurrentUser> {
  const cu = await getCurrentUser();
  if (!cu) {
    const path = (await headers()).get("x-homebase-pathname") ?? "/budget";
    redirect(`/login?next=${encodeURIComponent(path)}`);
  }
  return cu;
}

/** Admin-only sections (Connections, Users, AI, Backups). Members get a 404, not a hint. */
export async function requireAdmin(): Promise<CurrentUser> {
  const cu = await requireUser();
  if (cu.user.role !== "admin") notFound();
  return cu;
}

export function isAdmin(cu: CurrentUser | null): boolean {
  return cu?.user.role === "admin";
}

export type SignInResult =
  | { ok: true }
  | { ok: false; error: string; remaining?: number; lockedMinutes?: number };

/**
 * Per-user in-process mutex (first layer; the store's `reserve` is the cross-process one). Attempts for
 * the same user run one at a time, so a burst queues up behind the slow argon2 verify and each later
 * attempt sees the earlier outcome. Kept on globalThis so every bundled copy of this module (RSC,
 * actions, route handlers) shares it.
 */
const LOCKS_KEY = Symbol.for("homebase.pinUserLocks");
type LockG = typeof globalThis & { [LOCKS_KEY]?: Map<string, Promise<void>> };

async function withUserLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const g = globalThis as LockG;
  const locks = (g[LOCKS_KEY] ??= new Map());
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  locks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

type PinVeto = { kind: "ip" } | { kind: "locked"; until: Date };

const WRONG = "Wrong username or password.";
/** Verified against when the username is unknown, so a miss takes as long as a wrong password. */
let dummyHash: Promise<string> | null = null;

/**
 * Check a username + password, enforce lockout + per-IP rate limit, and issue a 30-day httpOnly
 * session cookie. Unknown usernames and wrong passwords get the same answer.
 *
 * Race-safe: the lockout/IP checks and a PENDING attempt row (counted as a failure) are written in
 * one serialized step (`pinAttempts.reserve`) BEFORE argon2.verify, and attempts for one user are
 * also serialized in-process. A burst of concurrent guesses therefore gets at most
 * MAX_CONSECUTIVE_FAILURES verifications before the lockout trips, instead of all of them racing
 * past a check that only saw completed attempts.
 */
export async function signInWithPassword(username: string, password: string): Promise<SignInResult> {
  await applyDevPassword();
  const { users, pinAttempts } = getIdentityStores();
  const ip = await requestIp();
  const user = username.trim() ? await users.getByUsername(username) : null;

  return withUserLock(`user:${user?.id ?? "unknown"}`, async () => {
    const now = new Date();
    const reservation = await pinAttempts.reserve<PinVeto>(
      {
        userId: user?.id ?? null,
        ip,
        at: now,
        userSince: new Date(now.getTime() - FAILURE_MEMORY_MS),
        ipSince: new Date(now.getTime() - IP_WINDOW_MS),
      },
      ({ history, ipCount }) => {
        if (isIpRateLimited(ipCount)) return { kind: "ip" };
        const locked = user?.passwordHash ? lockoutUntil(history, now) : null;
        return locked ? { kind: "locked", until: locked } : null;
      },
    );
    if (!reservation.ok) {
      if (reservation.veto.kind === "ip") {
        log.warn({ ip }, "sign-in rate limited");
        return { ok: false, error: "Too many attempts from this device. Wait 15 minutes and try again." };
      }
      return { ok: false, error: "Too many wrong passwords.", lockedMinutes: minutesUntil(reservation.veto.until, now) };
    }
    // The reserved row already counts as a failure (for the IP limit, too).
    const hash = user?.passwordHash ?? (await (dummyHash ??= argon2.hash("not-a-real-password", { type: argon2.argon2id })));
    const valid = isValidPasswordFormat(password) && (await argon2.verify(hash, password).catch(() => false));
    if (!user?.passwordHash || !valid) {
      log.info({ userId: user?.id ?? null, ip }, "sign-in rejected");
      if (!user?.passwordHash) return { ok: false, error: WRONG };
      const after = [{ userId: user.id, ip, success: false, at: now }, ...reservation.history];
      const lockedNow = lockoutUntil(after, now);
      if (lockedNow) return { ok: false, error: "Too many wrong passwords.", lockedMinutes: minutesUntil(lockedNow, now) };
      return { ok: false, error: WRONG, remaining: remainingBeforeLockout(after, now) };
    }
    await pinAttempts.complete(reservation.id, true);
    return issueSession(user, ip, now);
  });
}

async function issueSession(user: User, ip: string, now: Date): Promise<SignInResult> {
  const { sessions } = getIdentityStores();
  const token = randomBytes(32).toString("base64url");
  const h = await headers();
  await sessions.create({
    tokenHash: hashToken(token),
    userId: user.id,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    ip,
    userAgent: h.get("user-agent"),
  });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env().NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  log.info({ userId: user.id }, "password sign-in");
  return { ok: true };
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await getIdentityStores().sessions.delete(hashToken(token));
  jar.delete(SESSION_COOKIE);
}

/** Hash a password for storage (Settings → Users). */
export async function hashPassword(password: string): Promise<string> {
  if (!isValidPasswordFormat(password)) throw new Error("A password is 6 to 200 characters.");
  return argon2.hash(password, { type: argon2.argon2id });
}
