/**
 * Settings data paths against Postgres: credential storage (SimpleFIN claim mocked, never echoed),
 * CSV import with dedupe, Fidelity positions, push preferences/VAPID keys, rules, all audited.
 */
import { randomBytes } from "node:crypto";
process.env.HOMEBASE_MASTER_KEY ??= randomBytes(32).toString("base64");

import { afterAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { parseGenericCsv } from "@homebase/connectors";
import { userCtx } from "@homebase/core";
import { decryptSecret, schema as s } from "@homebase/db";
import { prepareWebTestDb } from "@/test/db";
import { addOrRotateConnection, listConnections } from "./connections";
import { importTransactions } from "./imports";
import { generateVapidKeys, getOrCreateVapidPublic, getPushPreferences, saveSubscription, setPushPreference } from "./push";
import { insertRule, listRules, previewRuleAgainstHistory, updateRule } from "./rules";

const t = await prepareWebTestDb("settings");

describe.skipIf(!t)("Settings data (Postgres)", () => {
  const db = t!.db;
  afterAll(async () => t?.close());
  const ctxFor = async () => {
    const [u] = await db.select().from(s.users).where(eq(s.users.role, "admin"));
    return { ctx: userCtx(db, u!.id, "2026-10-22"), userId: u!.id };
  };

  it("claims a SimpleFIN setup token, stores the access URL encrypted, shows only the last 4", async () => {
    const { ctx } = await ctxFor();
    const access = "https://user:secretpass1234@bridge.example/simplefin";
    const r = await addOrRotateConnection(db, ctx, { provider: "simplefin", setupToken: "aHR0cHM6Ly9leGFtcGxlLmNvbS9jbGFpbS90b2tlbg==" }, { claim: async () => access });
    expect(r.last4).toBe("1234");
    const [row] = await db.select().from(s.connections).where(eq(s.connections.id, r.id));
    expect(JSON.parse(decryptSecret(row!.encCredentials!))).toEqual({ accessUrl: access });
    const list = await listConnections(db);
    expect(JSON.stringify(list)).not.toContain("secretpass");
    expect(list.find((c) => c.id === r.id)).toMatchObject({ provider: "simplefin", last4: "1234", hasCredentials: true, requestsToday: 0 });
    // rotate a Mercury token on a new row, then the audit trail
    const m = await addOrRotateConnection(db, ctx, { provider: "mercury", token: "secret-token-abcd" });
    await addOrRotateConnection(db, ctx, { provider: "mercury", connectionId: m.id, token: "secret-token-wxyz" });
    expect((await listConnections(db)).find((c) => c.id === m.id)?.last4).toBe("wxyz");
    const audits = await db.select().from(s.auditLog).where(like(s.auditLog.action, "connection.%"));
    expect(audits.map((a) => a.action).sort()).toEqual(["connection.create", "connection.create", "connection.rotate_credentials"]);
    expect(JSON.stringify(audits)).not.toContain("secret-token");
    await expect(addOrRotateConnection(db, ctx, { provider: "coinbase", connectionId: m.id, keyName: "k", privateKeyPem: "-----BEGIN EC PRIVATE KEY-----x" })).rejects.toThrow(/provider/);
  });

  it("imports a CSV once: re-importing the same file skips every row", async () => {
    const { ctx } = await ctxFor();
    const [acct] = await db.select().from(s.accounts).where(eq(s.accounts.kind, "checking"));
    const csv = "Date,Description,Amount\n10/01/2026,HARDWARE STORE 123,-45.10\n10/02/2026,PAYROLL,2000.00\n10/03/2026,COFFEE SHOP,-4.50\n";
    const txns = parseGenericCsv(csv, acct!.id, { date: "Date", amount: "Amount", description: "Description", payee: "Description" }).transactions;
    const a = await importTransactions(ctx, { accountId: acct!.id, txns, source: "csv", kind: "csv", fileName: "oct.csv" });
    expect(a).toMatchObject({ imported: 3, exact: 0, skippedExisting: 0, from: "2026-10-01", to: "2026-10-03" });
    const rows = await db.select().from(s.transactions).where(and(eq(s.transactions.accountId, acct!.id), eq(s.transactions.source, "csv")));
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => !r.approved && r.catz === null && r.cleared === "cleared" && r.importHash)).toBe(true);
    const b = await importTransactions(ctx, { accountId: acct!.id, txns, source: "csv", kind: "csv", fileName: "oct.csv" });
    expect(b.imported).toBe(0);
    expect(b.exact + b.skippedExisting).toBe(3);
    const audit = await db.select().from(s.auditLog).where(eq(s.auditLog.action, "import.csv"));
    expect(audit).toHaveLength(2);
  });

  it("push: VAPID keys in the worker's format, per-user preferences, subscriptions", async () => {
    const { ctx, userId } = await ctxFor();
    const k = generateVapidKeys();
    expect(Buffer.from(k.publicKey, "base64url")).toHaveLength(65);
    expect(Buffer.from(k.privateKey, "base64url")).toHaveLength(32);
    const v = await getOrCreateVapidPublic(db);
    expect((await getOrCreateVapidPublic(db)).publicKey).toBe(v.publicKey);
    const [row] = await db.select().from(s.settings).where(eq(s.settings.key, "push_vapid"));
    expect(row!.value).toMatchObject({ public_key: v.publicKey, subject: expect.stringMatching(/^mailto:/) });
    expect(Buffer.from(decryptSecret(row!.encValue!), "base64url")).toHaveLength(32);

    expect((await getPushPreferences(db, userId)).digest).toBe(true);
    await setPushPreference(ctx, userId, "digest", false);
    expect((await getPushPreferences(db, userId)).digest).toBe(false);
    const [prefs] = await db.select().from(s.settings).where(eq(s.settings.key, "push_preferences"));
    expect(prefs!.value).toEqual({ [userId]: { digest: false } });

    const sub = { endpoint: "https://push.example/abc", keys: { p256dh: "p".repeat(20), auth: "a".repeat(10) } };
    await saveSubscription(db, userId, sub, "test");
    await saveSubscription(db, userId, sub, "test again");
    expect(await db.select().from(s.pushSubscriptions)).toHaveLength(1);
  });

  it("rules: insert canonical JSON, preview against history, disable", async () => {
    const { ctx } = await ctxFor();
    const id = await insertRule(ctx, { name: "Coffee", rule: { conditions: [{ field: "payee", op: "contains", value: "coffee" }], actions: { autoApprove: true } } });
    const preview = await previewRuleAgainstHistory(db, { conditions: [{ field: "payee", op: "contains", value: "coffee" }], actions: {} });
    expect(preview.matchCount).toBeGreaterThan(0);
    await updateRule(ctx, id, { enabled: false });
    const r = (await listRules(db)).find((x) => x.id === id)!;
    expect(r).toMatchObject({ enabled: false, error: null, rule: { conditions: [{ field: "payee", op: "contains", value: "coffee" }] } });
    expect((await db.select().from(s.auditLog).where(eq(s.auditLog.entityId, id))).map((a) => a.action)).toEqual(expect.arrayContaining(["rule.create", "rule.disable"]));
  });
});
