/**
 * Password sign-in under a concurrent burst (security review finding: the lockout and per-IP checks ran
 * before a slow argon2.verify and the attempt was recorded after it, so 50 parallel guesses all got
 * verified). argon2 is replaced by a slow counting fake so the test measures how many verifications
 * actually run.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { users as usersTable } from "@homebase/db";
import { MAX_CONSECUTIVE_FAILURES, lockoutUntil } from "./identity/pin-policy";
import { createMemoryStores } from "./identity/memory-store";
import { createDbStores } from "./identity/db-store";
import { setIdentityStores } from "./identity/stores";
import type { IdentityStores } from "./identity/types";
import { prepareWebTestDb } from "../test/db";

const fake = vi.hoisted(() => ({ verifications: 0, ip: "100.64.0.7" }));

vi.mock("argon2", () => {
  const verify = async (hash: string, pin: string) => {
    fake.verifications++;
    await new Promise((r) => setTimeout(r, 15)); // argon2id is deliberately slow
    return hash === `fake-hash:${pin}`;
  };
  const hash = async (pin: string) => `fake-hash:${pin}`;
  return { default: { verify, hash, argon2id: 2 }, verify, hash, argon2id: 2 };
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": fake.ip, "user-agent": "vitest" }),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("notFound"); }, redirect: () => { throw new Error("redirect"); } }));

const { signInWithPassword } = await import("./auth");

const BURST = 50;
const PW = "hunter22";

async function burst(username: string, n = BURST) {
  return Promise.all(Array.from({ length: n }, () => signInWithPassword(username, "wrong-one")));
}

function expectLockedBurst(results: Awaited<ReturnType<typeof burst>>) {
  expect(fake.verifications).toBeLessThanOrEqual(MAX_CONSECUTIVE_FAILURES);
  expect(fake.verifications).toBe(MAX_CONSECUTIVE_FAILURES);
  expect(results.every((r) => !r.ok)).toBe(true);
  expect(results.filter((r) => !r.ok && r.error === "Wrong username or password.")).toHaveLength(MAX_CONSECUTIVE_FAILURES - 1);
  expect(results.filter((r) => !r.ok && r.error === "Too many wrong passwords.")).toHaveLength(BURST - (MAX_CONSECUTIVE_FAILURES - 1));
}

beforeEach(() => {
  fake.verifications = 0;
});

describe("signInWithPassword concurrency (memory store)", () => {
  it(`${BURST} concurrent wrong passwords run at most ${MAX_CONSECUTIVE_FAILURES} verifications, then lock — even for the right password`, async () => {
    const stores = createMemoryStores([{ id: "u1", displayName: "Alex", username: "alex", tailscaleLogin: null, role: "admin", passwordHash: `fake-hash:${PW}` }]);
    setIdentityStores(stores);
    fake.ip = "100.64.0.7";
    expectLockedBurst(await burst("alex"));
    const right = await signInWithPassword("Alex", PW);
    expect(right).toMatchObject({ ok: false, error: "Too many wrong passwords." });
    expect(fake.verifications).toBe(MAX_CONSECUTIVE_FAILURES);
  });

  it("the per-IP limit also holds under a burst against an unknown user", async () => {
    setIdentityStores(createMemoryStores([]));
    fake.ip = "100.64.0.8";
    const results = await burst("nobody", 40);
    expect(results.filter((r) => !r.ok && r.error.startsWith("Too many attempts from this device"))).toHaveLength(20);
    // Unknown usernames still pay for one verify (against a dummy hash) so they look like a wrong password.
    expect(fake.verifications).toBe(20);
    expect(results.filter((r) => !r.ok && r.error === "Wrong username or password.")).toHaveLength(20);
  });

  it("a correct password still signs in when not locked, with any username case", async () => {
    setIdentityStores(createMemoryStores([{ id: "u2", displayName: "Sam", username: "sam", tailscaleLogin: null, role: "member", passwordHash: `fake-hash:${PW}` }]));
    fake.ip = "100.64.0.9";
    expect(await signInWithPassword(" Sam ", PW)).toEqual({ ok: true });
  });
});

const t = await prepareWebTestDb("auth");

describe.skipIf(!t)("signInWithPassword concurrency (Postgres store)", () => {
  const db = t!.db;
  let stores: IdentityStores;
  afterAll(async () => {
    await t?.close();
  });

  it(`${BURST} concurrent wrong passwords run at most ${MAX_CONSECUTIVE_FAILURES} verifications`, async () => {
    stores = createDbStores(db);
    setIdentityStores(stores);
    const [alex] = await db.select().from(usersTable).where(eq(usersTable.displayName, "Alex"));
    await db.update(usersTable).set({ username: "alex" }).where(eq(usersTable.id, alex!.id));
    await stores.users.setPasswordHash(alex!.id, `fake-hash:${PW}`);
    fake.ip = "100.64.0.20";
    expectLockedBurst(await burst("alex"));
    expect(lockoutUntil(await stores.pinAttempts.recentForUser(alex!.id, new Date(Date.now() - 60_000)), new Date())).not.toBeNull();
  });

  it("the db reservation alone (no in-process mutex, e.g. two web processes) grants at most 5 slots", async () => {
    const [sam] = await db.select().from(usersTable).where(eq(usersTable.displayName, "Sam"));
    const at = new Date();
    const since = new Date(at.getTime() - 60 * 60_000);
    const results = await Promise.all(
      Array.from({ length: BURST }, () =>
        stores.pinAttempts.reserve({ userId: sam!.id, ip: "100.64.0.21", at, userSince: since, ipSince: since }, ({ history }) => lockoutUntil(history, at)),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(MAX_CONSECUTIVE_FAILURES);
  });
});
