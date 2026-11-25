/** secrets, push, backup/health checks, net-worth snapshot, scheduled materialize, categorize shadow, digest. */
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accounts, aiMessages, assetValuations, assets, balances, connections, createKeyring, entities, generateMasterKey, loans, pushSubscriptions, scheduledTransactions, settings, transactions, users, type Db } from "@homebase/db";
import { runWeeklyDigest } from "../src/jobs/digest";
import { snapshotNetworth } from "../src/jobs/networth";
import { checkBackupFreshness, runBackupCheck, runCategorize, runConnectionHealth } from "../src/jobs/ops";
import { materializeScheduled } from "../src/jobs/scheduled";
import { defaultCategorizer } from "../src/hooks";
import { silentLogger } from "../src/log";
import { createPusher, getOrCreateVapidKeys, type SendFn } from "../src/push";
import { bootstrapConnections, decryptCredentials, loadConnections } from "../src/secrets";
import { setSetting } from "../src/settings";
import { freshDb, makeCtx } from "./helpers";

let db: Db;
let pool: pg.Pool;
const keyring = createKeyring(generateMasterKey());

beforeAll(async () => {
  ({ db, pool } = await freshDb());
});
afterAll(async () => {
  await pool?.end();
});

describe("secrets", () => {
  it("encrypts bootstrap env credentials into a connection row once; the row then wins over env", async () => {
    const log = silentLogger();
    const env = { MERCURY_TOKEN: "secret-token:mercury-abcdef123456", YNAB_TOKEN: "ynab-pat-0123456789" };
    expect((await bootstrapConnections({ db, log, keyring, env })).sort()).toEqual(["mercury", "ynab"]);
    expect(await bootstrapConnections({ db, log, keyring, env: { MERCURY_TOKEN: "secret-token:other-999999999" } })).toEqual([]);
    const rows = await db.select().from(connections);
    expect(rows).toHaveLength(2);
    const merc = rows.find((r) => r.provider === "mercury")!;
    expect(merc.credentialsLast4).toBe("3456");
    expect(merc.encCredentials!.toString("utf8")).not.toContain("mercury-abcdef");
    expect(decryptCredentials("mercury", merc.encCredentials!, keyring)).toEqual({ token: env.MERCURY_TOKEN });
    const loaded = await loadConnections({ db, log, keyring, env: {} }, "mercury");
    expect(loaded.map((l) => l.creds.token)).toEqual([env.MERCURY_TOKEN]);
    // Wrong key → the connection is flagged, nothing is thrown or leaked.
    const other = await loadConnections({ db, log, keyring: createKeyring(generateMasterKey()), env: {} }, "mercury");
    expect(other).toEqual([]);
    const [flagged] = await db.select().from(connections).where(eq(connections.id, merc.id));
    expect(flagged!.status).toBe("error");
    expect(flagged!.lastError).not.toContain("mercury-abcdef");
  });
});

describe("push", () => {
  it("creates VAPID keys once (private key encrypted), honors preferences and prunes 404/410", async () => {
    const [alex] = await db.insert(users).values({ displayName: "Alex", role: "admin" }).returning();
    const [sam] = await db.insert(users).values({ displayName: "Sam", role: "member" }).returning();
    await db.insert(pushSubscriptions).values([
      { userId: alex!.id, endpoint: "https://push.example.test/a", keys: { p256dh: "p", auth: "a" } },
      { userId: alex!.id, endpoint: "https://push.example.test/gone", keys: { p256dh: "p", auth: "a" } },
      { userId: sam!.id, endpoint: "https://push.example.test/h", keys: { p256dh: "p", auth: "a" } },
    ]);
    const sent: { endpoint: string; payload: string; vapid: unknown }[] = [];
    const send: SendFn = async (sub, payload, opts) => {
      if (sub.endpoint.endsWith("/gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
      sent.push({ endpoint: sub.endpoint, payload, vapid: opts.vapidDetails });
      return { statusCode: 201 };
    };
    const pusher = createPusher({ db, log: silentLogger(), subject: "mailto:test@homebase.invalid", keyring, send });
    const r = await pusher.sendToAdmins("backup", { title: "Backup problem", body: "stale" });
    expect(r).toMatchObject({ sent: 1, pruned: 1, failed: 0 });
    expect(JSON.parse(sent[0]!.payload)).toMatchObject({ title: "Backup problem", type: "backup" });
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, "https://push.example.test/gone"))).toEqual([]);

    const [vapid] = await db.select().from(settings).where(eq(settings.key, "push_vapid"));
    expect(vapid!.value).toMatchObject({ public_key: expect.any(String), subject: "mailto:test@homebase.invalid" });
    expect(vapid!.encValue).toBeInstanceOf(Buffer);
    const again = await getOrCreateVapidKeys(db, "mailto:x@homebase.invalid", keyring);
    expect(again.publicKey).toBe((vapid!.value as { public_key: string }).public_key);

    await setSetting(db, "push_preferences", { [sam!.id]: { digest: false } });
    const all = await pusher.sendToAll("digest", { title: "Digest", body: "…" });
    expect(all.sent).toBe(1); // Alex only
    expect(sent.map((s) => s.endpoint)).toEqual(["https://push.example.test/a", "https://push.example.test/a"]);
  });
});

describe("backup.check and health.connections", () => {
  it("flags missing, stale and failed backups and pushes admins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hb-backups-"));
    const now = new Date("2026-10-22T08:00:00Z");
    expect(await checkBackupFreshness(dir, now, 26)).toMatchObject({ ok: false, reason: "no successful backup recorded" });
    await writeFile(join(dir, ".last-success"), "2026-10-22T03:31:00-0400 homebase.dump\n");
    await utimes(join(dir, ".last-success"), new Date("2026-10-22T07:31:00Z"), new Date("2026-10-22T07:31:00Z"));
    expect(await checkBackupFreshness(dir, now, 26)).toMatchObject({ ok: true, ageHours: 0 });
    expect(await checkBackupFreshness(dir, new Date("2026-10-23T10:00:00Z"), 26)).toMatchObject({ ok: false, ageHours: 26 });
    await writeFile(join(dir, ".last-failure"), "2026-10-22T03:35:00-0400\n");
    const { ctx, rec } = makeCtx(db, { env: { BACKUP_DIR: dir }, now: () => now });
    expect(await runBackupCheck(ctx)).toMatchObject({ ok: false, pushed: true });
    expect(rec.pushes).toEqual([{ to: "admins", type: "backup", msg: expect.objectContaining({ title: "Backup problem" }) }]);
  });

  it("pushes only for connections needing attention for more than 24 h", async () => {
    await db.insert(connections).values([
      { provider: "simplefin", label: "old", status: "needs_attention", meta: { needsAttentionSince: "2026-10-20T08:00:00Z", issues: [{ code: "con.auth", msg: "x", banner: "Reconnect Contoso Bank in SimpleFIN" }] } },
      { provider: "simplefin", label: "fresh", status: "needs_attention", meta: { needsAttentionSince: "2026-10-22T07:00:00Z" } },
    ]);
    const { ctx, rec } = makeCtx(db, { now: () => new Date("2026-10-22T12:00:00Z") });
    const r = await runConnectionHealth(ctx);
    expect(r.stale).toHaveLength(1);
    expect(rec.pushes.map((p) => p.msg.body)).toEqual(["Reconnect Contoso Bank in SimpleFIN"]);
  });
});

describe("categorize jobs", () => {
  it("run in shadow mode during the YNAB parallel run and live after cutover", async () => {
    const { ctx, rec } = makeCtx(db);
    expect(await runCategorize(ctx, "pending", { transactionIds: [] })).toMatchObject({ shadow: false });
    await setSetting(db, "ynab_import", { plan_id: "p", plan_name: "x", server_knowledge: 1, imported_at: "2026-10-01T00:00:00Z" });
    expect(await runCategorize(ctx, "batch")).toMatchObject({ shadow: true });
    await setSetting(db, "ynab_cutover_date", "2026-10-22");
    expect(await runCategorize(ctx, "pending")).toMatchObject({ shadow: false });
    await setSetting(db, "categorizer_shadow", true);
    expect(await runCategorize(ctx, "pending")).toMatchObject({ shadow: true });
    expect(rec.categorize.map((c) => c.shadow)).toEqual([false, true, false, true]);
    await db.delete(settings).where(eq(settings.key, "categorizer_shadow"));
  });
});

describe("categorize default wiring", () => {
  it("runs @homebase/categorizer's job (no API key → rules/history only) in shadow mode", async () => {
    const [ent] = await db.insert(entities).values({ name: "Shadow Test" }).returning();
    const [acct] = await db.insert(accounts).values({ entityId: ent!.id, name: "Chk", kind: "checking", onBudget: true, source: "simplefin" }).returning();
    const [t] = await db.insert(transactions).values({ accountId: acct!.id, date: "2026-10-20", amountMilli: -12_340n, rawDescription: "KROGER #123 FAIRVIEW VA", source: "simplefin", cleared: "cleared", externalId: "x-1" }).returning();
    const r = await defaultCategorizer("pending", undefined)({ db, log: silentLogger(), shadow: true, transactionIds: [t!.id] });
    expect(r.processed).toBe(1);
    expect(r.note).toMatch(/^shadow:/);
    const [after] = await db.select().from(transactions).where(eq(transactions.id, t!.id));
    expect(after!.categoryId).toBeNull(); // shadow mode writes nothing on transactions
    await db.delete(transactions).where(eq(transactions.id, t!.id));
    await db.delete(accounts).where(eq(accounts.id, acct!.id));
    await db.delete(entities).where(eq(entities.id, ent!.id));
  });
});

describe("snapshot.networth and scheduled.materialize", () => {
  it("writes computed balances for loans, the home, crypto and ledger accounts; keeps synced ones", async () => {
    const [ent] = await db.insert(entities).values({ name: "Household" }).returning();
    const mk = (name: string, kind: "mortgage" | "property" | "crypto" | "checking", source: "manual" | "rentcast" | "coinbase" | "simplefin") =>
      db.insert(accounts).values({ entityId: ent!.id, name, kind, onBudget: kind === "checking", source }).returning().then((r) => r[0]!);
    const mort = await mk("Maple St mortgage", "mortgage", "manual");
    const home = await mk("Maple St", "property", "rentcast");
    const cash = await mk("Cash", "checking", "manual");
    const synced = await mk("Contoso Checking", "checking", "simplefin");
    await db.insert(loans).values({ accountId: mort.id, originalPrincipalMilli: 300_000_000n, annualRate: "0.065", termMonths: 360, firstPaymentDate: "2026-01-01", piPaymentMilli: 1_896_200n });
    const [asset] = await db.insert(assets).values({ kind: "home", name: "Maple St", address: "1 Maple St", accountId: home.id }).returning();
    await db.insert(assetValuations).values({ assetId: asset!.id, asOf: "2026-10-02", valueMilli: 412_000_000n, source: "rentcast" });
    await db.insert(transactions).values([
      { accountId: cash.id, date: "2026-10-01", amountMilli: 500_000n, source: "manual", cleared: "cleared" },
      { accountId: cash.id, date: "2026-10-05", amountMilli: -120_000n, source: "manual", cleared: "cleared" },
      { accountId: cash.id, date: "2026-10-21", amountMilli: -5_000n, source: "manual", cleared: "pending" },
    ]);
    await db.insert(balances).values({ accountId: synced.id, asOf: "2026-10-22", currentMilli: 4_210_550n, source: "simplefin" });
    const { ctx } = makeCtx(db);
    const r = await snapshotNetworth(ctx);
    expect(r.skippedSynced).toBe(1);
    const rows = new Map((await db.select().from(balances).where(eq(balances.asOf, "2026-10-22"))).map((b) => [b.accountId, b]));
    expect(rows.get(cash.id)).toMatchObject({ currentMilli: 380_000n, source: "manual" });
    expect(rows.get(home.id)).toMatchObject({ currentMilli: 412_000_000n, source: "rentcast" });
    expect(rows.get(synced.id)!.currentMilli).toBe(4_210_550n);
    const m = rows.get(mort.id)!;
    expect(m.source).toBe("amortization");
    expect(m.currentMilli < -296_000_000n && m.currentMilli > -300_000_000n).toBe(true); // 10 payments in
  });

  it("materializes due scheduled transactions (skipped during the parallel run) and advances next_date", async () => {
    const [cash] = await db.select().from(accounts).where(eq(accounts.name, "Cash"));
    const [s] = await db.insert(scheduledTransactions).values({ accountId: cash!.id, amountMilli: -60_000n, frequency: "monthly", firstDate: "2026-09-20", nextDate: "2026-09-20" }).returning();
    const { ctx } = makeCtx(db);
    await db.delete(settings).where(eq(settings.key, "ynab_cutover_date"));
    expect(await materializeScheduled(ctx)).toMatchObject({ skipped: expect.stringContaining("parallel run") });
    await setSetting(db, "ynab_cutover_date", "2026-10-22");
    expect(await materializeScheduled(ctx)).toMatchObject({ created: 2, advanced: 1, earliestMonth: "2026-09-01" });
    const rows = await db.select().from(transactions).where(eq(transactions.scheduledTransactionId, s!.id));
    expect(rows.map((t) => [t.date, t.amountMilli, t.source, t.cleared]).sort()).toEqual([
      ["2026-09-20", -60_000n, "scheduled", "uncleared"],
      ["2026-10-20", -60_000n, "scheduled", "uncleared"],
    ]);
    const [after] = await db.select().from(scheduledTransactions).where(eq(scheduledTransactions.id, s!.id));
    expect(after!.nextDate).toBe("2026-11-20");
    expect(await materializeScheduled(ctx)).toMatchObject({ created: 0 }); // idempotent
  });
});

describe("digest.weekly", () => {
  it("stores the digest as a chat message referenced by settings.digest_latest and pushes it", async () => {
    const { ctx, rec } = makeCtx(db);
    const r = await runWeeklyDigest(ctx);
    const [msg] = await db.select().from(aiMessages).where(eq(aiMessages.id, r.messageId));
    expect(msg!.role).toBe("assistant");
    const [latest] = await db.select().from(settings).where(eq(settings.key, "digest_latest"));
    expect(latest!.value).toMatchObject({ conversation_id: r.conversationId, message_id: r.messageId, week_end: "2026-10-22" });
    expect(rec.pushes).toEqual([{ to: "all", type: "digest", msg: expect.objectContaining({ tag: "digest" }) }]);
    expect(r.digest.source).toBe("deterministic");
  });
});
