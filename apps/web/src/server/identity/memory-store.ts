import type { IdentityStores, PinAttempt, PinAttemptSnapshot, PinAttemptStore, PinReservation, Session, SessionStore, User, UserStore } from "./types";

/** In-memory identity stores. Process-local and lost on restart — temporary until the db pass. */
export class MemoryUserStore implements UserStore {
  private users = new Map<string, User>();
  constructor(seed: User[]) {
    for (const u of seed) this.users.set(u.id, { ...u });
  }
  async list() {
    return [...this.users.values()].map((u) => ({ ...u }));
  }
  async getById(id: string) {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }
  async getByTailscaleLogin(login: string) {
    const needle = login.trim().toLowerCase();
    for (const u of this.users.values()) if (u.tailscaleLogin?.toLowerCase() === needle) return { ...u };
    return null;
  }
  async getByUsername(username: string) {
    const needle = username.trim().toLowerCase();
    for (const u of this.users.values()) if (u.username?.toLowerCase() === needle) return { ...u };
    return null;
  }
  async getByEmail(email: string) {
    const needle = email.trim().toLowerCase();
    for (const u of this.users.values()) if (u.email?.toLowerCase() === needle) return { ...u };
    return null;
  }
  async setPasswordHash(userId: string, passwordHash: string | null) {
    const u = this.users.get(userId);
    if (u) u.passwordHash = passwordHash;
  }
}

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();
  async create(s: Session) {
    this.sessions.set(s.tokenHash, { ...s });
  }
  async get(tokenHash: string) {
    const s = this.sessions.get(tokenHash);
    return s ? { ...s } : null;
  }
  async delete(tokenHash: string) {
    this.sessions.delete(tokenHash);
  }
  async deleteForUser(userId: string) {
    for (const [k, s] of this.sessions) if (s.userId === userId) this.sessions.delete(k);
  }
}

export class MemoryPinAttemptStore implements PinAttemptStore {
  private attempts: (PinAttempt & { id?: string })[] = [];
  private seq = 0;
  /** Check + insert run synchronously (no await in between), so concurrent calls can't interleave. */
  async reserve<V>(
    input: { userId: string | null; ip: string; at: Date; userSince: Date; ipSince: Date },
    gate: (seen: PinAttemptSnapshot) => V | null,
  ): Promise<PinReservation<V>> {
    const history = input.userId ? this.recentSync(input.userId, input.userSince) : [];
    const veto = gate({ history, ipCount: this.countSync(input.ip, input.ipSince) });
    if (veto !== null) return { ok: false, veto };
    const id = `pin_${++this.seq}`;
    this.push({ id, userId: input.userId, ip: input.ip, success: false, at: input.at });
    return { ok: true, id, history };
  }
  async complete(id: string, success: boolean) {
    const a = this.attempts.find((x) => x.id === id);
    if (a) a.success = success;
  }
  async record(a: PinAttempt) {
    this.push({ ...a });
  }
  private push(a: PinAttempt & { id?: string }) {
    this.attempts.push(a);
    // keep memory bounded: drop anything older than a day
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    if (this.attempts.length > 1000) this.attempts = this.attempts.filter((x) => x.at.getTime() >= cutoff);
  }
  async recentForUser(userId: string, since: Date) {
    return this.recentSync(userId, since);
  }
  async countForIp(ip: string, since: Date) {
    return this.countSync(ip, since);
  }
  private recentSync(userId: string, since: Date): PinAttempt[] {
    return this.attempts
      .filter((a) => a.userId === userId && a.at >= since)
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .map(({ userId: u, ip, success, at }) => ({ userId: u, ip, success, at }));
  }
  private countSync(ip: string, since: Date): number {
    return this.attempts.filter((a) => a.ip === ip && a.at >= since).length;
  }
}

export function createMemoryStores(seed: User[]): IdentityStores {
  return { users: new MemoryUserStore(seed), sessions: new MemorySessionStore(), pinAttempts: new MemoryPinAttemptStore() };
}
