/** household_memory (spec §5.4, §11.3 `remember`): plain facts the assistant reads and users edit. */
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { householdMemory, users, type HouseholdMemory } from "@homebase/db";
import { writeAudit } from "./audit";
import { withTx, type Ctx, type DbLike } from "./context";
import { NotFoundError } from "./errors";

const FactSchema = z.string().trim().min(1).max(1000);

export async function listMemory(db: DbLike): Promise<(HouseholdMemory & { createdByName: string | null })[]> {
  const rows = await db
    .select({ m: householdMemory, name: users.displayName })
    .from(householdMemory)
    .leftJoin(users, eq(users.id, householdMemory.createdBy))
    .orderBy(asc(householdMemory.createdAt), asc(householdMemory.id));
  return rows.map((r) => ({ ...r.m, createdByName: r.name }));
}

/** Add a fact (the AI `remember(fact)` tool, after confirmation). */
export async function addMemory(ctx: Ctx, text: string): Promise<HouseholdMemory> {
  const t = FactSchema.parse(text);
  return withTx(ctx, async (tx, c) => {
    const [row] = await tx.insert(householdMemory).values({ text: t, createdBy: c.userId }).returning();
    await writeAudit(tx, c, { action: "memory.add", entity: "household_memory", entityId: row!.id, after: { text: t } });
    return row!;
  });
}
export const remember = addMemory;

export async function updateMemory(ctx: Ctx, id: string, text: string): Promise<HouseholdMemory> {
  const t = FactSchema.parse(text);
  return withTx(ctx, async (tx, c) => {
    const [before] = await tx.select().from(householdMemory).where(eq(householdMemory.id, id));
    if (!before) throw new NotFoundError("memory", id);
    const [row] = await tx.update(householdMemory).set({ text: t }).where(eq(householdMemory.id, id)).returning();
    await writeAudit(tx, c, { action: "memory.update", entity: "household_memory", entityId: id, before: { text: before.text }, after: { text: t } });
    return row!;
  });
}

export async function deleteMemory(ctx: Ctx, id: string): Promise<void> {
  await withTx(ctx, async (tx, c) => {
    const [row] = await tx.delete(householdMemory).where(eq(householdMemory.id, id)).returning();
    if (!row) throw new NotFoundError("memory", id);
    await writeAudit(tx, c, { action: "memory.delete", entity: "household_memory", entityId: id, before: { text: row.text } });
  });
}
