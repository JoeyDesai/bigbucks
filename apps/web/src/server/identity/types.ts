/**
 * Persistence interfaces for identity. This pass ships an in-memory implementation
 * (`memory-store.ts`); the second pass backs these with the db `users`, `sessions` and
 * `pin_attempts` tables. Keep these small and storage-agnostic.
 */
export type Role = "admin" | "member";
/** UI accent: a named accent (USER_ACCENTS in @homebase/shared) or a custom "#rrggbb"; null = the default blue. */
export type Accent = "gold" | "blue" | "pink" | "green" | "purple" | "orange" | "teal" | `#${string}`;

export interface User {
  id: string;
  displayName: string;
  /** Tailscale login (e.g. "alex@example.com") used for header identity. */
  tailscaleLogin: string | null;
  /** Sign-in name for the password login. */
  username?: string | null;
  /** Sign-in email for Cloudflare Access. */
  email?: string | null;
  role: Role;
  /** argon2id hash of the password, or null if password login is off for this user. */
  passwordHash: string | null;
  /** UI accent color; null/undefined = blue. */
  accent?: Accent | null;
}

export interface Session {
  /** sha256(hex) of the opaque cookie token. The raw token is never stored. */
  tokenHash: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

export interface PinAttempt {
  userId: string | null;
  ip: string;
  success: boolean;
  at: Date;
}

export interface UserStore {
  list(): Promise<User[]>;
  getById(id: string): Promise<User | null>;
  getByTailscaleLogin(login: string): Promise<User | null>;
  getByEmail(email: string): Promise<User | null>;
  getByUsername(username: string): Promise<User | null>;
  setPasswordHash(userId: string, passwordHash: string | null): Promise<void>;
}

export interface SessionStore {
  create(session: Session): Promise<void>;
  get(tokenHash: string): Promise<Session | null>;
  delete(tokenHash: string): Promise<void>;
  deleteForUser(userId: string): Promise<void>;
}

/** What `PinAttemptStore.reserve` lets the caller's gate see, read under the reservation lock. */
export interface PinAttemptSnapshot {
  /** The user's attempts at or after `userSince`, newest first (empty for an unknown user). */
  history: PinAttempt[];
  /** Attempts (any outcome, pending included) from the IP at or after `ipSince`. */
  ipCount: number;
}

export type PinReservation<V> = { ok: true; id: string; history: PinAttempt[] } | { ok: false; veto: V };

export interface PinAttemptStore {
  /**
   * Atomically — across concurrent requests and, for the db store, across processes — read the
   * user's history and the IP count, let `gate` veto (return non-null), and otherwise insert a
   * PENDING attempt that already counts as a failure. Call this BEFORE the slow argon2 verify so a
   * burst of concurrent guesses each see the others; flip the row with `complete(id, true)` on a match.
   * A vetoed attempt is not recorded.
   */
  reserve<V>(
    input: { userId: string | null; ip: string; at: Date; userSince: Date; ipSince: Date },
    gate: (seen: PinAttemptSnapshot) => V | null,
  ): Promise<PinReservation<V>>;
  /** Resolve a reserved attempt. */
  complete(id: string, success: boolean): Promise<void>;
  record(attempt: PinAttempt): Promise<void>;
  /** Attempts for a user at or after `since`, newest first. */
  recentForUser(userId: string, since: Date): Promise<PinAttempt[]>;
  /** Number of attempts (any outcome) from an IP at or after `since`. */
  countForIp(ip: string, since: Date): Promise<number>;
}

export interface IdentityStores {
  users: UserStore;
  sessions: SessionStore;
  pinAttempts: PinAttemptStore;
}
