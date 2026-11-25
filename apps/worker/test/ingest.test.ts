/**
 * SimpleFIN ingest of the synthetic fixture into <base>_worker_test (§8.2, §8.4). No network: the
 * connector gets an injected fetch that serves packages/connectors/test/fixtures/simplefin-v2.json.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accounts, balances, categories, categoryGroups, connections, entities, rawPayloads, scheduledTransactions, syncRuns, transactions, type Db } from "@homebase/db";
import { createKeyring, generateMasterKey } from "@homebase/db";
import { syncSimplefin } from "../src/jobs/sync/simplefin";
import { metaOf } from "../src/ingest/syncRuns";
import { defaultTransferDetector, type TransferDetector } from "../src/hooks";
import { storeCredentials } from "../src/secrets";
import { CONNECTOR_FIXTURES, freshDb, makeCtx, readFixture, simplefinFetch } from "./helpers";

type Fixture = { errlist: unknown[]; connections: unknown[]; accounts: Array<{ id: string; transactions: Array<Record<string, unknown>> }> };

const ACCESS_URL = "https://demo-user:demo-pass-123456@bridge.example.test/simplefin";

/** The real §8.3 detector from @homebase/categorizer. */
const cardPaymentDetector: TransferDetector = defaultTransferDetector();

let db: Db;
let pool: pg.Pool;
const keyring = createKeyring(generateMasterKey());
let fixture: Fixture;
let connId: string;

const count = async (q: string) => Number(Object.values((await pool.query(q)).rows[0] as object)[0]);

beforeAll(async () => {
  ({ db, pool } = await freshDb());
  fixture = readFixture<Fixture>(`${CONNECTOR_FIXTURES}/simplefin-v2.json`);
  connId = await storeCredentials({ db, keyring }, "simplefin", { accessUrl: ACCESS_URL });
});

afterAll(async () => {
  await pool?.end();
});

describe("SimpleFIN ingest", () => {
  it("lands new accounts in the inbox (off budget), writes balances, transactions and pending rows", async () => {
    const http = simplefinFetch(() => fixture);
    const { ctx, rec } = makeCtx(db, { fetch: http.fetch, keyring });
    const [summary] = await syncSimplefin(ctx, { trigger: "scheduled" });
    expect(summary).toMatchObject({ provider: "simplefin", status: "ok", requestsUsed: 1, accountsSeen: 4, txAdded: 17, newInboxAccounts: 4 });

    // One GET with pending=1 and a single 31-day window; credentials only in the Authorization header.
    expect(http.calls).toHaveLength(1);
    const u = new URL(http.calls[0]!.url);
    expect([u.host, u.username, u.password, u.searchParams.get("version"), u.searchParams.get("pending")]).toEqual(["bridge.example.test", "", "", "2", "1"]);
    expect(http.calls[0]!.auth).toMatch(/^Basic /);
    expect(http.calls[0]!.method).toBe("GET");

    const accts = await db.select().from(accounts).orderBy(accounts.externalId);
    expect(accts).toHaveLength(4);
    expect(accts.every((a) => a.onBudget === false && a.connectionId === connId && a.source === "simplefin")).toBe(true);
    expect(accts.map((a) => [a.externalId, a.kind])).toEqual([
      ["ACT-card-0002", "credit_card"],
      ["ACT-checking-0001", "checking"],
      ["ACT-fabrikam-0004", "credit_card"],
      ["ACT-savings-0003", "savings"],
    ]);
    const [household] = await db.select().from(entities).where(eq(entities.name, "Household"));
    expect(accts.every((a) => a.entityId === household!.id)).toBe(true);
    const [conn] = await db.select().from(connections).where(eq(connections.id, connId));
    expect(metaOf(conn!).inbox?.map((i) => i.externalId).sort()).toEqual(accts.map((a) => a.externalId).sort());
    expect(conn!.status).toBe("ok");
    expect(metaOf(conn!).backfill).toEqual({ target: "2026-09-22", coveredFrom: "2026-09-22", done: true });

    const bal = await db.select().from(balances);
    expect(bal).toHaveLength(4);
    const card = accts.find((a) => a.externalId === "ACT-card-0002")!;
    expect(bal.find((b) => b.accountId === card.id)).toMatchObject({ asOf: "2026-10-22", currentMilli: -1384220n });

    expect(await count("select count(*) from transactions")).toBe(17);
    const pending = await db.select().from(transactions).where(eq(transactions.cleared, "pending"));
    expect(pending.map((p) => p.externalId).sort()).toEqual(["TRN-c-005", "TRN-d-004", "TRN-v-006"]);
    const all = await db.select().from(transactions);
    expect(all.every((t) => t.approved === false && t.categoryId === null && t.importHash?.length === 64)).toBe(true);
    expect(all.filter((t) => t.cleared === "cleared")).toHaveLength(14);

    const runs = await db.select().from(syncRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "ok", requestsUsed: 1, accountsSeen: 4, txAdded: 17 });
    expect((runs[0]!.errors as { trigger: string }).trigger).toBe("scheduled");
    expect(await count("select count(*) from raw_payloads")).toBe(1);
    // The raw payload never holds credentials.
    expect(JSON.stringify((await db.select().from(rawPayloads))[0]!.body)).not.toContain("demo-pass");

    expect(rec.enqueued.map((e) => e.name)).toEqual(["categorize.pending"]);
    expect((rec.enqueued[0]!.data as { transactionIds: string[] }).transactionIds).toHaveLength(17);
    expect(rec.recomputed).toEqual(["2026-10-01"]);
  });

  it("re-ingesting the same payload is idempotent", async () => {
    const http = simplefinFetch(() => fixture);
    const { ctx, rec } = makeCtx(db, { fetch: http.fetch, keyring });
    const [summary] = await syncSimplefin(ctx, { trigger: "scheduled" });
    expect(summary).toMatchObject({ status: "ok", requestsUsed: 1, txAdded: 0, txUpdated: 0, newInboxAccounts: 0 });
    expect(await count("select count(*) from accounts")).toBe(4);
    expect(await count("select count(*) from transactions")).toBe(17);
    expect(await count("select count(*) from balances")).toBe(4);
    expect(rec.enqueued).toEqual([]);
    // A 14-day overlap window now (backfill done).
    const u = new URL(http.calls[0]!.url);
    expect(Number(u.searchParams.get("end-date")) - Number(u.searchParams.get("start-date"))).toBe(15 * 86_400);
  });

  it("pending → posted replaces the row in place and keeps the user's category and memo", async () => {
    const [cat] = await db.insert(categoryGroups).values({ name: "Needs" }).returning();
    const [gas] = await db.insert(categories).values({ groupId: cat!.id, name: "Gas" }).returning();
    const [pend] = await db.select().from(transactions).where(eq(transactions.externalId, "TRN-v-006"));
    await db.update(transactions).set({ categoryId: gas!.id, memo: "road trip", approved: true }).where(eq(transactions.id, pend!.id));

    // Bank posts the Shell charge with a new id and the final amount (+5.6%), and drops the power-bill hold.
    const next = structuredClone(fixture);
    const card = next.accounts.find((a) => a.id === "ACT-card-0002")!;
    card.transactions = card.transactions.filter((t) => t.id !== "TRN-v-006");
    card.transactions.push({ id: "TRN-v-106", posted: 1792713600, transacted_at: 1792627200, amount: "-55.00", description: "SHELL OIL 00000000 FAIRVIEW VA", payee: "Shell", memo: "", mcc: "5541", pending: false });
    const chk = next.accounts.find((a) => a.id === "ACT-checking-0001")!;
    chk.transactions = chk.transactions.filter((t) => t.id !== "TRN-c-005");

    const { ctx } = makeCtx(db, { fetch: simplefinFetch(() => next).fetch, keyring });
    const [summary] = await syncSimplefin(ctx, { trigger: "scheduled" });
    expect(summary).toMatchObject({ txAdded: 0 });

    const [after] = await db.select().from(transactions).where(eq(transactions.id, pend!.id));
    expect(after).toMatchObject({ externalId: "TRN-v-106", cleared: "cleared", amountMilli: -55000n, categoryId: gas!.id, memo: "road trip", deletedAt: null });
    expect(after!.approved).toBe(false); // amount changed → back to review
    const [gone] = await db.select().from(transactions).where(eq(transactions.externalId, "TRN-c-005"));
    expect(gone!.deletedAt).not.toBeNull(); // released hold
    expect(await count("select count(*) from transactions where deleted_at is null")).toBe(16);
  });

  it("enforces the SimpleFIN budget from sync_runs (6/day incl. manual, manual ≤ 2/day)", async () => {
    // 3 requests used so far today. Two manual syncs are fine, the third manual is refused.
    const http = simplefinFetch(() => fixture);
    const { ctx } = makeCtx(db, { fetch: http.fetch, keyring });
    expect((await syncSimplefin(ctx, { trigger: "manual" }))[0]).toMatchObject({ status: "ok", requestsUsed: 1 });
    expect((await syncSimplefin(ctx, { trigger: "manual" }))[0]).toMatchObject({ status: "ok", requestsUsed: 1 });
    expect((await syncSimplefin(ctx, { trigger: "manual" }))[0]).toMatchObject({ status: "skipped", requestsUsed: 0, reason: expect.stringContaining("2 per day") });
    // Scheduled: 5 used → one more allowed, then the day is closed.
    expect((await syncSimplefin(ctx, { trigger: "scheduled" }))[0]).toMatchObject({ status: "ok" });
    expect((await syncSimplefin(ctx, { trigger: "scheduled" }))[0]).toMatchObject({ status: "skipped", reason: expect.stringContaining("6 requests") });
    expect(http.calls).toHaveLength(3);
    expect(await count("select coalesce(sum(requests_used),0) from sync_runs")).toBe(6);
    // Next day the budget resets.
    const tomorrow = makeCtx(db, { fetch: http.fetch, keyring, now: () => new Date("2026-10-23T10:00:00Z") });
    expect((await syncSimplefin(tomorrow.ctx, { trigger: "scheduled" }))[0]).toMatchObject({ status: "ok", requestsUsed: 1 });
  });

  it("con.auth marks the connection needs_attention with the reconnect banner", async () => {
    const next = structuredClone(fixture);
    next.errlist = [{ code: "con.auth", msg: "Login failed", conn_id: "CON-co000000001" }];
    const { ctx } = makeCtx(db, { fetch: simplefinFetch(() => next).fetch, keyring, now: () => new Date("2026-10-24T10:00:00Z") });
    expect((await syncSimplefin(ctx, { trigger: "scheduled" }))[0]).toMatchObject({ status: "needs_attention" });
    const [conn] = await db.select().from(connections).where(eq(connections.id, connId));
    expect(conn).toMatchObject({ status: "needs_attention", lastError: "Reconnect Contoso Bank in SimpleFIN" });
    expect(metaOf(conn!).needsAttentionSince).toBe("2026-10-24T10:00:00.000Z");
  });
});

describe("matching against existing rows during ingest", () => {
  it("links mapped YNAB accounts, merges YNAB rows (keeping category/memo), matches scheduled rows and pairs card payments", async () => {
    ({ db, pool } = await freshDb());
    const conn = await storeCredentials({ db, keyring }, "simplefin", { accessUrl: ACCESS_URL });
    const [ent] = await db.insert(entities).values({ name: "Household" }).returning();
    const [grp] = await db.insert(categoryGroups).values({ name: "Bills" }).returning();
    const [power] = await db.insert(categories).values({ groupId: grp!.id, name: "💡 Electric" }).returning();
    const [shop] = await db.insert(categories).values({ groupId: grp!.id, name: "Groceries" }).returning();
    const [chkAcct] = await db.insert(accounts).values({ entityId: ent!.id, name: "Checking", kind: "checking", onBudget: true, source: "ynab_import", ynabId: "y-acct-chk" }).returning();
    const [cardAcct] = await db.insert(accounts).values({ entityId: ent!.id, name: "Cash Back Card", kind: "credit_card", onBudget: true, source: "ynab_import", ynabId: "y-acct-card" }).returning();
    await db.update(connections).set({ meta: { accountMap: { "ACT-checking-0001": { accountId: chkAcct!.id }, "ACT-fabrikam-0004": { accountId: cardAcct!.id } } } }).where(eq(connections.id, conn));
    // YNAB already has the Kroger charge (2026-10-16 in the fixture) with a category and memo.
    const [ynabRow] = await db
      .insert(transactions)
      .values({ accountId: cardAcct!.id, date: "2026-10-15", amountMilli: -96440n, rawDescription: "Kroger", memo: "weekly shop", categoryId: shop!.id, cleared: "cleared", approved: true, source: "ynab_import", ynabId: "y-tx-kroger" })
      .returning();
    // A materialized scheduled power bill, $0.01 off and 2 days early.
    const [sched] = await db.insert(scheduledTransactions).values({ accountId: chkAcct!.id, amountMilli: -90000n, frequency: "monthly", firstDate: "2026-09-19", nextDate: "2026-11-19", categoryId: power!.id }).returning();
    const [schedRow] = await db
      .insert(transactions)
      .values({ accountId: chkAcct!.id, date: "2026-10-19", amountMilli: -90000n, categoryId: power!.id, cleared: "uncleared", approved: true, source: "scheduled", scheduledTransactionId: sched!.id })
      .returning();

    const { ctx } = makeCtx(db, { fetch: simplefinFetch(() => fixture).fetch, keyring, detectTransfers: cardPaymentDetector });
    const [summary] = await syncSimplefin(ctx, { trigger: "scheduled" });
    expect(summary).toMatchObject({ status: "ok", accountsSeen: 4, newInboxAccounts: 2, txAdded: 15 });

    const linked = await db.select().from(accounts).where(isNull(accounts.deletedAt));
    expect(linked).toHaveLength(4);
    expect(linked.find((a) => a.id === chkAcct!.id)).toMatchObject({ externalId: "ACT-checking-0001", connectionId: conn, source: "simplefin", onBudget: true });
    const [c] = await db.select().from(connections).where(eq(connections.id, conn));
    expect(metaOf(c!).inbox?.map((i) => i.externalId).sort()).toEqual(["ACT-card-0002", "ACT-savings-0003"]);

    const [merged] = await db.select().from(transactions).where(eq(transactions.id, ynabRow!.id));
    expect(merged).toMatchObject({ externalId: "TRN-d-002", matchedYnabId: "y-tx-kroger", categoryId: shop!.id, memo: "weekly shop", source: "simplefin", amountMilli: -96440n });
    expect(await count(`select count(*) from transactions where amount_milli = -96440`)).toBe(1);

    const [s] = await db.select().from(transactions).where(eq(transactions.id, schedRow!.id));
    expect(s).toMatchObject({ externalId: "TRN-c-005", amountMilli: -89990n, cleared: "pending", categoryId: power!.id });

    // Contoso autopay (checking −612.40) ↔ the Contoso card +612.40, and Fabrikam e-payment ↔ the Fabrikam card.
    const pairs = await db.select().from(transactions).where(sql`${transactions.transferPairId} is not null`);
    expect(pairs.map((p) => p.externalId).sort()).toEqual(["TRN-c-002", "TRN-c-004", "TRN-d-003", "TRN-v-004"]);
    const out = pairs.find((p) => p.externalId === "TRN-c-004")!;
    const inn = pairs.find((p) => p.externalId === "TRN-d-003")!;
    expect([out.transferPairId, inn.transferPairId, out.transferAccountId, inn.transferAccountId]).toEqual([inn.id, out.id, cardAcct!.id, chkAcct!.id]);
    expect(out.catz).toMatchObject({ method: "transfer" });
    expect(await count(`select count(*) from transactions where transfer_pair_id is not null and category_id is not null`)).toBe(0);

    // Unrelated new rows are untouched by the pairing.
    const fresh = await db.select().from(transactions).where(and(eq(transactions.externalId, "TRN-v-001")));
    expect(fresh[0]).toMatchObject({ transferPairId: null, categoryId: null });
  });
});
