/**
 * `import:ynab-snapshot` (YNAB web-UI snapshot) against <base>_worker_test with a synthetic fixture,
 * then the full `import:ynab` adopting its categories and replacing its opening balances.
 */
import { and, eq, isNull } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accounts, categories, categoryGroups, connections, monthAssignments, monthNotes, settings, targets, users, type Db } from "@homebase/db";
import { getBudgetMonth } from "@homebase/core";
import { recomputeBudget } from "../src/budget";
import { upsertHouseholdUsers } from "../src/household";
import { ensureEntity, HOUSEHOLD_ENTITY } from "../src/ingest/accounts";
import { importYnabPlan } from "../src/ynab/import";
import { formatParity, ynabParity } from "../src/ynab/parity";
import { OPENING_NOTE, UI_SNAPSHOT_KEY, formatSnapshotSummary, importUiSnapshot, parseCardFlags, parseUiSnapshot, undoUiSnapshot, type UiSnapshotSetting } from "../src/ynab/snapshot";
import { ENGINE_SYNTHETIC_PLAN, freshDb, readFixture } from "./helpers";

const FIXTURE = new URL("./fixtures/ynab-ui-snapshot-synthetic.json", import.meta.url).pathname;
const TODAY = "2026-10-22";
const now = new Date("2026-10-22T16:00:00Z");

let db: Db;
let pool: pg.Pool;
const count = async (q: string) => Number(Object.values((await pool.query(q)).rows[0] as object)[0]);
const counts = async () => ({
  groups: await count("select count(*) from category_groups"),
  categories: await count("select count(*) from categories"),
  assignments: await count("select count(*) from month_assignments"),
  targets: await count("select count(*) from targets"),
  notes: await count("select count(*) from month_notes"),
  sum: await count("select coalesce(sum(assigned_milli), 0) from month_assignments"),
});
const cat = async (name: string) => (await db.select().from(categories).where(and(eq(categories.name, name), isNull(categories.deletedAt))))[0]!;
const assigned = async (month: string, categoryId: string) =>
  (await db.select({ a: monthAssignments.assignedMilli }).from(monthAssignments).where(and(eq(monthAssignments.month, month), eq(monthAssignments.categoryId, categoryId))))[0]?.a ?? null;
const fixture = () => readFixture<Record<string, unknown>>(FIXTURE);

afterAll(async () => {
  await pool?.end();
});

describe("CLI helpers", () => {
  it("parses --card flags and validates the file", () => {
    expect(parseCardFlags(["Fabrikam Card=abc", "A=B=c"])).toEqual({ "Fabrikam Card": "abc", "A=B": "c" });
    expect(() => parseCardFlags(["nope"])).toThrow(/expected/);
    expect(() => parseUiSnapshot({ month: "2026-10-15", groups: [] })).toThrow();
    expect(parseUiSnapshot(fixture()).groups).toHaveLength(4);
  });
});

describe("import:ynab-snapshot", () => {
  let visaId: string;
  let connId: string;

  beforeAll(async () => {
    ({ db, pool } = await freshDb());
    const household = await db.transaction((tx) => ensureEntity(tx, HOUSEHOLD_ENTITY));
    await db.insert(accounts).values({ entityId: household, name: "Checking", kind: "checking", onBudget: true, source: "simplefin" });
    const [visa] = await db.insert(accounts).values({ entityId: household, name: "Visa", kind: "credit_card", onBudget: false, source: "simplefin", externalId: "V1" }).returning();
    visaId = visa!.id;
    const [conn] = await db
      .insert(connections)
      .values({ provider: "simplefin", label: "SimpleFIN", meta: { inbox: [{ accountId: visaId, externalId: "V1", name: "Visa", kindGuess: "credit_card", detectedAt: "2026-10-20" }] } })
      .returning();
    connId = conn!.id;
  });

  it("dry run reports everything and writes nothing", async () => {
    const before = await counts();
    const s = await importUiSnapshot(db, fixture(), { file: "synthetic.json", dryRun: true, cards: { Visa: visaId }, onBudget: [visaId], now, today: TODAY });
    expect(s.dryRun).toBe(true);
    expect(s.categories.created).toBe(6);
    expect(await counts()).toEqual(before);
    const [v] = await db.select().from(accounts).where(eq(accounts.id, visaId));
    expect(v!.onBudget).toBe(false);
  });

  it("imports groups, categories, icons, targets, assignments and opening balances in one go", async () => {
    const s = await importUiSnapshot(db, fixture(), { file: "synthetic.json", cards: { Visa: visaId }, onBudget: [visaId], now, today: TODAY });
    expect(s).toMatchObject({
      month: "2026-10-01",
      openingMonth: "2026-09-01",
      undidPrevious: false,
      groups: { created: 3, updated: 0 },
      categories: { created: 6, updated: 0, hidden: 2 },
      targets: { set: 2, removed: 0 },
      assigned: { count: 5, total: 485000n },
      carry: { count: 4, total: 210000n },
      cards: { linked: [{ category: "Visa", accountId: visaId }], pending: [] },
      onBudget: ["Visa"],
    });
    expect(s.verify.mismatches).toEqual([]);
    expect(s.verify.readyToAssign.file).toBe(4800000n);
    expect(formatSnapshotSummary(s)).toMatch(/all match YNAB/);

    // Inbox card moved onto the budget with its payment category.
    const [v] = await db.select().from(accounts).where(eq(accounts.id, visaId));
    expect(v!.onBudget).toBe(true);
    const [conn] = await db.select().from(connections).where(eq(connections.id, connId));
    expect((conn!.meta as { inbox: unknown[] }).inbox).toEqual([]);
    const pay = (await db.select().from(categories).where(eq(categories.linkedAccountId, visaId)))[0]!;
    expect(pay).toMatchObject({ kind: "cc_payment", icon: "credit-card" });

    // No normal "Credit Card Payments" group; groups in file order.
    const groups = await db.select().from(categoryGroups).where(eq(categoryGroups.isSystem, false));
    expect(groups.sort((a, b) => a.sort - b.sort).map((g) => g.name)).toEqual(["Bills", "Needs", "Wants"]);

    const rent = await cat("Rent");
    const groc = await cat("Groceries");
    const invest = await cat("Invest");
    const fun = await cat("Fun");
    const gym = await cat("Gym");
    const water = await cat("Water");
    expect([rent.icon, groc.icon, invest.icon, fun.icon, gym.icon, water.icon]).toEqual(["house", "apple", "landmark", "popcorn", "dumbbell", "droplet"]);
    expect([rent.hidden, groc.hidden, gym.hidden, water.hidden]).toEqual([false, false, true, true]);

    const rentT = await db.select().from(targets).where(eq(targets.categoryId, rent.id));
    expect(rentT).toEqual([expect.objectContaining({ effectiveFrom: "2026-10-01", type: "need_set_aside", amountMilli: 150000n, cadence: "monthly", day: 1, removed: false })]);
    const grocT = await db.select().from(targets).where(eq(targets.categoryId, groc.id));
    expect(grocT).toEqual([expect.objectContaining({ type: "need_refill", amountMilli: 210000n, day: null })]);

    expect([await assigned("2026-10-01", rent.id), await assigned("2026-10-01", invest.id), await assigned("2026-10-01", pay.id)]).toEqual([150000n, 50000n, null]);
    expect([await assigned("2026-09-01", rent.id), await assigned("2026-09-01", groc.id), await assigned("2026-09-01", fun.id), await assigned("2026-09-01", pay.id), await assigned("2026-09-01", invest.id)]).toEqual([150000n, 30000n, 10000n, 20000n, null]);
    const [note] = await db.select().from(monthNotes).where(and(eq(monthNotes.month, "2026-09-01"), isNull(monthNotes.categoryId)));
    expect(note!.note).toBe(OPENING_NOTE);

    const [st] = await db.select().from(settings).where(eq(settings.key, UI_SNAPSHOT_KEY));
    const rec = st!.value as UiSnapshotSetting;
    expect(rec).toMatchObject({ file: "synthetic.json", month: "2026-10-01", openingMonth: "2026-09-01" });
    expect(new Set(rec.categoryIds)).toEqual(new Set([rent.id, groc.id, invest.id, fun.id, gym.id, water.id, pay.id]));
    expect(new Set(rec.openingCategoryIds)).toEqual(new Set([rent.id, groc.id, fun.id, pay.id]));

    // Available before activity matches YNAB: carry-in + assigned.
    const view = await getBudgetMonth(db, "2026-10-01", { today: TODAY });
    const all = [...view.groups.flatMap((g) => g.categories), ...view.hidden];
    const byId = new Map(all.map((c) => [c.id, c]));
    expect([byId.get(rent.id)!.carryIn, byId.get(rent.id)!.available, byId.get(rent.id)!.icon]).toEqual([150000n, 300000n, "house"]);
    expect(byId.get(pay.id)!.carryIn).toBe(20000n);
  });

  it("re-running is idempotent (undo, then apply again)", async () => {
    const before = await counts();
    const s = await importUiSnapshot(db, fixture(), { file: "synthetic.json", cards: { Visa: visaId }, now, today: TODAY });
    expect(s).toMatchObject({ undidPrevious: true, groups: { created: 0, updated: 3 }, categories: { created: 0, updated: 6 } });
    expect(await counts()).toEqual(before);
    expect(s.verify.mismatches).toEqual([]);
  });

  it("a changed file replaces the previous numbers; unknown --card names are rejected", async () => {
    const f = fixture() as { groups: { name: string; categories: { name: string; assigned: number; carryIn: number; available: number }[] }[] };
    const rentRow = f.groups[1]!.categories[0]!;
    rentRow.carryIn = 0;
    rentRow.available = 0;
    await importUiSnapshot(db, f, { file: "synthetic.json", cards: { Visa: visaId }, now, today: TODAY });
    const rent = await cat("Rent");
    expect(await assigned("2026-09-01", rent.id)).toBeNull();
    await expect(importUiSnapshot(db, fixture(), { file: "x", cards: { Nope: visaId }, now, today: TODAY })).rejects.toThrow(/no such category/);
    await importUiSnapshot(db, fixture(), { file: "synthetic.json", cards: { Visa: visaId }, now, today: TODAY });
    expect(await assigned("2026-09-01", rent.id)).toBe(150000n);
  });

  it("undoUiSnapshot removes the opening balances, note, targets and record", async () => {
    await db.transaction((tx) => undoUiSnapshot(tx, { assignments: true }));
    expect(await count("select count(*) from month_assignments")).toBe(0);
    expect(await count("select count(*) from targets")).toBe(0);
    expect(await count("select count(*) from month_notes")).toBe(0);
    expect(await count(`select count(*) from settings where key = '${UI_SNAPSHOT_KEY}'`)).toBe(0);
    expect(await count("select count(*) from categories where name = 'Rent'")).toBe(1); // identity stays
  });

  it("refuses to run over a full YNAB import unless forced", async () => {
    await db.insert(settings).values({ key: "ynab_import", value: { plan_id: "x" } });
    await expect(importUiSnapshot(db, fixture(), { file: "x", now, today: TODAY })).rejects.toThrow(/--force/);
    const s = await importUiSnapshot(db, fixture(), { file: "x", force: true, dryRun: true, now, today: TODAY });
    expect(s.cards.linked.map((c) => c.category)).toEqual(["Visa"]); // already linked: matched by name
    await db.delete(settings).where(eq(settings.key, "ynab_import"));
  });
});

describe("import:ynab adopts snapshot categories", () => {
  const raw = readFixture(ENGINE_SYNTHETIC_PLAN);

  beforeAll(async () => {
    ({ db, pool } = await freshDb());
  });

  it("matches by normalized name instead of duplicating, and YNAB's history replaces the snapshot's", async () => {
    const s0 = await importUiSnapshot(db, fixture(), { file: "synthetic.json", now, today: TODAY });
    expect(s0.cards.pending).toEqual(["Visa"]); // no card yet: left for later
    const snapIds = { groc: (await cat("Groceries")).id, fun: (await cat("Fun")).id, rent: (await cat("Rent")).id, gym: (await cat("Gym")).id };
    const bills0 = (await db.select().from(categoryGroups).where(eq(categoryGroups.name, "Bills")))[0]!;

    const s = await importYnabPlan(db, raw, { now });
    expect(s.snapshotUndone).toBe(true);
    expect(s.adopted.categories).toBe(4); // Rent, Groceries, Invest (same group), Fun (unique name, other group)
    expect(s.adopted.groups).toBeGreaterThanOrEqual(2); // Bills, Needs (+ the internal system group)

    // Same rows, now carrying YNAB ids; icons from the snapshot kept.
    const groc = await cat("Groceries");
    expect([groc.id, groc.ynabId, groc.icon]).toEqual([snapIds.groc, "groc", "apple"]);
    const fun = await cat("Fun");
    const needs = (await db.select().from(categoryGroups).where(eq(categoryGroups.ynabId, "g-needs")))[0]!;
    expect([fun.id, fun.ynabId, fun.groupId, fun.icon]).toEqual([snapIds.fun, "fun", needs.id, "popcorn"]);
    expect((await cat("Rent")).ynabId).toBe("rent");
    expect(await count("select count(*) from categories where lower(name) in ('groceries', 'rent', 'fun', 'invest') and deleted_at is null")).toBe(4);
    expect(await count("select count(*) from category_groups where name = 'Bills'")).toBe(1);
    expect((await db.select().from(categoryGroups).where(eq(categoryGroups.name, "Bills")))[0]!).toMatchObject({ id: bills0.id, ynabId: "g-bills" });
    // Snapshot-only categories stay, without YNAB ids or numbers.
    const gym = await cat("Gym");
    expect([gym.id, gym.ynabId, await assigned("2026-10-01", gym.id)]).toEqual([snapIds.gym, null, null]);

    // The snapshot's record, note and targets are gone; YNAB's target and history rule.
    expect(await count(`select count(*) from settings where key = '${UI_SNAPSHOT_KEY}'`)).toBe(0);
    expect(await count("select count(*) from month_notes")).toBe(0);
    expect(await db.select({ type: targets.type, amount: targets.amountMilli, from: targets.effectiveFrom }).from(targets).where(eq(targets.categoryId, groc.id))).toEqual([{ type: "need_set_aside", amount: 200000n, from: "2026-09-01" }]);

    await recomputeBudget(db, { asOf: TODAY });
    const report = await ynabParity(db, raw);
    expect(formatParity(report)).toMatch(/matches YNAB exactly/);

    // Re-running the full import keeps it stable (no snapshot left to undo, nothing re-adopted).
    const again = await importYnabPlan(db, raw, { now });
    expect(again).toMatchObject({ snapshotUndone: false, adopted: { groups: 0, categories: 0 } });
    expect(await count("select count(*) from categories where lower(name) = 'groceries'")).toBe(1);
  });
});

describe("setup:household users", () => {
  it("defaults admin gold / member pink, keeps an existing accent, and lets a flag override it", async () => {
    await db.delete(users);
    await db.insert(users).values({ tailscaleLogin: "alex@example.com", displayName: "Alex", role: "admin" }); // accent null
    await db.transaction((tx) =>
      upsertHouseholdUsers(tx, [
        { login: "Alex@Example.com", name: "Alex", role: "admin" },
        { login: "sam@example.com", name: "Sam", role: "member" },
      ]),
    );
    const rows = async () => (await db.select({ l: users.tailscaleLogin, a: users.accent }).from(users).orderBy(users.tailscaleLogin)).map((r) => [r.l, r.a]);
    expect(await rows()).toEqual([
      ["alex@example.com", "gold"],
      ["sam@example.com", "pink"],
    ]);
    await db.update(users).set({ accent: "teal" }).where(eq(users.tailscaleLogin, "sam@example.com"));
    await db.transaction((tx) => upsertHouseholdUsers(tx, [{ login: "sam@example.com", name: "Sam", role: "member" }]));
    expect((await rows())[1]).toEqual(["sam@example.com", "teal"]);
    await db.transaction((tx) => upsertHouseholdUsers(tx, [{ login: "sam@example.com", name: "Sam", role: "member", accent: "purple" }]));
    expect((await rows())[1]).toEqual(["sam@example.com", "purple"]);
    expect(await count("select count(*) from users")).toBe(2);
  });
});
