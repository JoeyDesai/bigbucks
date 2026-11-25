/** Category icons, user accents and the inbox → on-budget helper (Hearth redesign data contract). */
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accounts, categories, connections, users } from "@homebase/db";
import { listAudit } from "../src/audit";
import { getBudgetMonth } from "../src/budget/view";
import { createCategory, listCategories, redo, setCategoryIcon, undo } from "../src/budget/operations";
import { ValidationError } from "../src/errors";
import { putAccountOnBudget, removeFromAccountInbox } from "../src/transactions/accounts";
import { getUser, getUserByTailscaleLogin, listUsers, setUserAccent } from "../src/users";
import { MONTH, TODAY, useDemoDb } from "./helpers";

const env = useDemoDb();

const catByName = async (name: string) => (await env.db.select().from(categories).where(eq(categories.name, name)))[0]!;

describe("category icons", () => {
  it("getBudgetMonth and listCategories expose the icon", async () => {
    const view = await getBudgetMonth(env.db, MONTH, { today: TODAY });
    const all = [...view.groups.flatMap((g) => g.categories), ...view.hidden];
    expect(all.find((c) => c.name === "Groceries")?.icon).toBe("shopping-basket");
    expect(all.find((c) => c.name === "Cash Back Card")?.icon).toBe("credit-card");
    expect(all.every((c) => "icon" in c)).toBe(true);
    const groups = await listCategories(env.db);
    expect(groups.flatMap((g) => g.categories).find((c) => c.name === "Mortgage")?.icon).toBe("house");
  });

  it("setCategoryIcon sets, clears, validates, audits and can be undone", async () => {
    const pets = await catByName("Pets");
    const r = await setCategoryIcon(env.ctx, pets.id, "dog");
    expect((await catByName("Pets")).icon).toBe("dog");
    expect(r.operationId).toBeTruthy();
    const audit = await listAudit(env.db, { entity: "category", entityId: pets.id });
    expect(audit[0]!.action).toMatch(/set_category_icon/);
    await undo(env.ctx, r.operationId!);
    expect((await catByName("Pets")).icon).toBe("paw-print");
    await redo(env.ctx, r.operationId!);
    expect((await catByName("Pets")).icon).toBe("dog");
    await setCategoryIcon(env.ctx, pets.id, null);
    expect((await catByName("Pets")).icon).toBeNull();
    await expect(setCategoryIcon(env.ctx, pets.id, "PawPrint")).rejects.toBeInstanceOf(ValidationError);
    await expect(setCategoryIcon(env.ctx, pets.id, "paw print")).rejects.toBeInstanceOf(ValidationError);
  });

  it("createCategory suggests an icon from the name unless one is given", async () => {
    const bills = (await listCategories(env.db)).find((g) => g.name === "Bills")!;
    await createCategory(env.ctx, { groupId: bills.id, name: "Netflix" });
    expect((await catByName("Netflix")).icon).toBe("tv");
    await createCategory(env.ctx, { groupId: bills.id, name: "Gym", icon: "dumbbell" });
    expect((await catByName("Gym")).icon).toBe("dumbbell");
    await createCategory(env.ctx, { groupId: bills.id, name: "Zzyzx" });
    expect((await catByName("Zzyzx")).icon).toBe("circle-dot");
  });
});

describe("user accents", () => {
  it("getters return accent; setUserAccent validates and audits", async () => {
    const alex = await getUser(env.db, env.alexId);
    expect(alex?.accent).toBe("blue");
    expect((await getUserByTailscaleLogin(env.db, "ALEX@example.com"))?.accent).toBe("blue");
    expect((await listUsers(env.db)).map((u) => [u.displayName, u.accent]).sort()).toEqual([
      ["Alex", "blue"],
      ["Sam", "pink"],
    ]);
    const u = await setUserAccent(env.ctx, env.alexId, "teal");
    expect(u.accent).toBe("teal");
    expect(u).not.toHaveProperty("passwordHash");
    expect((await getUser(env.db, env.alexId))?.accent).toBe("teal");
    const audit = await listAudit(env.db, { entity: "user", entityId: env.alexId, action: "user.set_accent" });
    expect(audit[0]).toMatchObject({ before: { accent: "blue" }, after: { accent: "teal" } });
    await setUserAccent(env.ctx, env.alexId, null);
    expect((await getUser(env.db, env.alexId))?.accent).toBeNull();
    await expect(setUserAccent(env.ctx, env.alexId, "red" as never)).rejects.toBeInstanceOf(ValidationError);
    // a custom "#rrggbb" accent (Settings → You → Custom)
    expect((await setUserAccent(env.ctx, env.alexId, "#ff8800")).accent).toBe("#ff8800");
    await expect(setUserAccent(env.ctx, env.alexId, "#FF88" as never)).rejects.toBeInstanceOf(ValidationError);
    await setUserAccent(env.ctx, env.alexId, "blue");
    const [row] = await env.db.select({ accent: users.accent }).from(users).where(eq(users.id, env.alexId));
    expect(row!.accent).toBe("blue");
  });
});

describe("putAccountOnBudget", () => {
  it("moves an inbox card onto the budget, creates its payment category and clears the inbox entry", async () => {
    const [business] = await env.db.execute<{ id: string }>(sql`SELECT id FROM entities ORDER BY sort DESC LIMIT 1`).then((r) => r.rows);
    const [card] = await env.db.insert(accounts).values({ entityId: business!.id, name: "New Visa", kind: "credit_card", onBudget: false, source: "simplefin" }).returning();
    const [conn] = await env.db
      .insert(connections)
      .values({ provider: "simplefin", label: "test", meta: { inbox: [{ accountId: card!.id, externalId: "X1", name: "New Visa", kindGuess: "credit_card", detectedAt: "2026-10-20" }, { accountId: "other", externalId: "X2", name: "Other", kindGuess: "checking", detectedAt: "2026-10-20" }] } })
      .returning();
    const a = await putAccountOnBudget(env.ctx, card!.id);
    expect(a.onBudget).toBe(true);
    const [household] = await env.db.execute<{ id: string }>(sql`SELECT id FROM entities ORDER BY sort ASC LIMIT 1`).then((r) => r.rows);
    expect(a.entityId).toBe(household!.id);
    const pay = (await env.db.select().from(categories).where(eq(categories.linkedAccountId, card!.id)))[0]!;
    expect(pay).toMatchObject({ kind: "cc_payment", icon: "credit-card", name: "New Visa" });
    const [after] = await env.db.select().from(connections).where(eq(connections.id, conn!.id));
    expect((after!.meta as { inbox: { accountId: string }[] }).inbox.map((e) => e.accountId)).toEqual(["other"]);
    expect(await removeFromAccountInbox(env.db, card!.id)).toBe(0);
  });
});
