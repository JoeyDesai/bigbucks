import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, payeeAliases, payees, transactions, users } from "@homebase/db";
import { listAudit } from "../src/audit";
import { ConflictError, ValidationError } from "../src/errors";
import { addMemory, deleteMemory, listMemory, updateMemory } from "../src/memory";
import { createAlias, deleteAlias, getPayee, listPayees, mergePayees, renamePayee, setPayeeDefaultCategory } from "../src/payees";
import { getAllSettings, getSetting, setSetting, settingDefault } from "../src/settings";
import { completePinAttempt, createSession, deleteSession, getSession, getUserByTailscaleLogin, isLockedOut, recordPinAttempt, reservePinAttempt, setPasswordHash, getPasswordHash, setUsername, getUserByUsername } from "../src/users";
import { useDemoDb } from "./helpers";

const env = useDemoDb();

describe("settings", () => {
  it("reads seeded values merged over defaults and validates writes", async () => {
    const ap = await getSetting(env.db, "approval_policy");
    expect(ap.auto_approve_ai_min_confidence).toBe(0.95);
    expect(ap.auto_approve_ai_max_abs_milli).toBe("150000");
    const models = await getSetting(env.db, "ai_models");
    expect(models.categorize).toBe("claude-haiku-5-5");
    expect(models.deep).toBe("claude-opus-5-5"); // not in the seed → default
    expect((await getSetting(env.db, "ai_budget")).monthly_cap_usd).toBe(8);
    expect(settingDefault("notifications").large_transaction_over_milli).toBe("500000");
    const next = await setSetting(env.ctx, "ai_budget", { monthly_cap_usd: 12 });
    expect(next).toMatchObject({ monthly_cap_usd: 12, warn_at_fraction: 0.8 });
    await expect(setSetting(env.ctx, "approval_policy", { auto_categorize_min_confidence: 2 })).rejects.toBeInstanceOf(ValidationError);
    const all = await getAllSettings(env.db);
    expect(all.ai_budget.monthly_cap_usd).toBe(12);
    expect(all.timezone).toBe("America/New_York");
    const audit = await listAudit(env.db, { entity: "setting", entityId: "ai_budget" });
    expect(audit[0]!.after).toMatchObject({ monthly_cap_usd: 12 });
  });
});

describe("household memory", () => {
  it("CRUD with audit", async () => {
    const n0 = (await listMemory(env.db)).length;
    const m = await addMemory(env.ctx, "  Gas is mostly Circle K.  ");
    expect(m.text).toBe("Gas is mostly Circle K.");
    await updateMemory(env.ctx, m.id, "Gas is mostly Circle K and Shell.");
    const list = await listMemory(env.db);
    expect(list).toHaveLength(n0 + 1);
    expect(list.find((x) => x.id === m.id)!.createdByName).toBe("Alex");
    await deleteMemory(env.ctx, m.id);
    expect(await listMemory(env.db)).toHaveLength(n0);
    const actions = (await env.db.select().from(auditLog).where(eq(auditLog.entityId, m.id))).map((a) => a.action).sort();
    expect(actions).toEqual(["memory.add", "memory.delete", "memory.update"]);
  });
});

describe("users and sessions", () => {
  it("finds users by Tailscale login and manages sessions", async () => {
    const u = await getUserByTailscaleLogin(env.db, "ALEX@example.com");
    expect(u?.displayName).toBe("Alex");
    expect(u).not.toHaveProperty("passwordHash");
    const { token, session } = await createSession(env.db, { userId: u!.id, ip: "100.64.0.1" });
    expect(session.tokenHash).not.toBe(token);
    expect((await getSession(env.db, token))?.user.id).toBe(u!.id);
    expect(await getSession(env.db, token, { now: new Date(Date.now() + 31 * 86_400_000) })).toBeNull();
    expect(await deleteSession(env.db, token)).toBe(true);
    expect(await getSession(env.db, token)).toBeNull();
    const s2 = await createSession(env.db, { userId: u!.id });
    await setPasswordHash(env.ctx, u!.id, "$argon2id$fake");
    expect(await getPasswordHash(env.db, u!.id)).toBe("$argon2id$fake");
    expect(await getSession(env.db, s2.token)).toBeNull(); // changing the password revokes sessions
  });

  it("usernames: lowercase, unique, validated, found case-insensitively", async () => {
    const [a, b] = await env.db.select().from(users).orderBy(users.createdAt).limit(2);
    await setUsername(env.ctx, a!.id, " Alex.D ");
    expect((await getUserByUsername(env.db, "ALEX.d"))?.id).toBe(a!.id);
    await expect(setUsername(env.ctx, b!.id, "alex.d")).rejects.toThrow(/already uses/);
    await expect(setUsername(env.ctx, b!.id, "x")).rejects.toThrow(/2 to 32/);
    await expect(setUsername(env.ctx, b!.id, "has space")).rejects.toThrow(/2 to 32/);
  });

  it("locks a user out after 5 failures in 15 minutes, and rate-limits an IP", async () => {
    const [sam] = await env.db.select().from(users).where(eq(users.displayName, "Sam"));
    const t0 = new Date("2026-10-22T12:00:00Z");
    for (let i = 0; i < 4; i++) await recordPinAttempt(env.db, { userId: sam!.id, ip: "100.64.0.2", success: false, now: new Date(t0.getTime() + i * 1000) });
    expect((await isLockedOut(env.db, { userId: sam!.id, now: new Date(t0.getTime() + 5000) })).locked).toBe(false);
    await recordPinAttempt(env.db, { userId: sam!.id, ip: "100.64.0.2", success: false, now: new Date(t0.getTime() + 5000) });
    const l = await isLockedOut(env.db, { userId: sam!.id, now: new Date(t0.getTime() + 6000) });
    expect(l).toMatchObject({ locked: true, reason: "user" });
    expect(l.retryAt!.getTime()).toBe(t0.getTime() + 15 * 60_000);
    expect((await isLockedOut(env.db, { userId: sam!.id, now: new Date(t0.getTime() + 16 * 60_000) })).locked).toBe(false);
    // a success resets the count
    await recordPinAttempt(env.db, { userId: sam!.id, ip: "100.64.0.2", success: true, now: new Date(t0.getTime() + 7000) });
    expect((await isLockedOut(env.db, { userId: sam!.id, now: new Date(t0.getTime() + 8000) })).locked).toBe(false);
    for (let i = 0; i < 20; i++) await recordPinAttempt(env.db, { userId: null, ip: "100.64.0.9", success: false, now: new Date(t0.getTime() + i) });
    expect(await isLockedOut(env.db, { ip: "100.64.0.9", now: new Date(t0.getTime() + 60_000) })).toMatchObject({ locked: true, reason: "ip" });
  });

  it("reservePinAttempt: a concurrent burst gets at most 5 reservations (pending rows count before verify)", async () => {
    const [alex] = await env.db.select().from(users).where(eq(users.displayName, "Alex"));
    const t0 = new Date("2026-10-23T12:00:00Z");
    // 50 concurrent attempts across the pool's connections (stand-ins for separate processes).
    const results = await Promise.all(Array.from({ length: 50 }, () => reservePinAttempt(env.db, { userId: alex!.id, ip: "100.64.0.30", now: t0 })));
    const granted = results.filter((r) => r.ok);
    expect(granted).toHaveLength(5);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.status.reason === "user")).toBe(true);
    // a reserved attempt that turns out correct resets the count
    const later = new Date(t0.getTime() + 16 * 60_000);
    const r = await reservePinAttempt(env.db, { userId: alex!.id, ip: "100.64.0.30", now: later });
    expect(r.ok).toBe(true);
    if (r.ok) await completePinAttempt(env.db, r.attemptId, true);
    expect((await isLockedOut(env.db, { userId: alex!.id, now: new Date(later.getTime() + 1000) })).locked).toBe(false);
    // the per-IP limit is enforced the same way (any user, including unknown ones)
    const ipBurst = await Promise.all(Array.from({ length: 40 }, () => reservePinAttempt(env.db, { userId: null, ip: "100.64.0.31", now: t0 })));
    expect(ipBurst.filter((x) => x.ok)).toHaveLength(20);
  });
});

describe("payees", () => {
  it("rename, default category, merge and aliases", async () => {
    const list = await listPayees(env.db, { q: "kro" });
    const kroger = list.find((p) => p.name === "Kroger")!;
    expect(kroger.transactionCount).toBeGreaterThan(0);
    const aldi = (await listPayees(env.db, { q: "aldi" }))[0]!;
    await expect(renamePayee(env.ctx, aldi.id, "KROGER")).rejects.toBeInstanceOf(ConflictError);
    await renamePayee(env.ctx, aldi.id, "ALDI Food Market");
    await setPayeeDefaultCategory(env.ctx, aldi.id, null);
    const n = aldi.transactionCount;
    const res = await mergePayees(env.ctx, { sourceIds: [aldi.id], targetId: kroger.id });
    expect(res.moved).toBe(n);
    expect(await env.db.select().from(transactions).where(eq(transactions.payeeId, aldi.id))).toHaveLength(0);
    const k = await getPayee(env.db, kroger.id);
    expect(k.aliases.some((a) => a.pattern === "ALDI Food Market" && a.match === "exact")).toBe(true);
    expect(k.aliases.some((a) => a.pattern === "ALDI ")).toBe(true); // moved over
    expect((await listPayees(env.db, { q: "aldi" })).length).toBe(0);
    await expect(createAlias(env.ctx, { payeeId: kroger.id, pattern: "(", match: "regex" })).rejects.toThrow();
    const a = await createAlias(env.ctx, { payeeId: kroger.id, pattern: "^KRG\\b", match: "regex" });
    await expect(createAlias(env.ctx, { payeeId: kroger.id, pattern: "^KRG\\b", match: "regex" })).rejects.toBeInstanceOf(ConflictError);
    await deleteAlias(env.ctx, a.id);
    expect(await env.db.select().from(payeeAliases).where(and(eq(payeeAliases.id, a.id)))).toHaveLength(0);
    const [p] = await env.db.select().from(payees).where(eq(payees.id, aldi.id));
    expect(p!.deletedAt).not.toBeNull();
  });
});
