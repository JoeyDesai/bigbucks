import "server-only";
import { asc, desc, eq, sql } from "drizzle-orm";
import { normalizedKey, parseRule, ruleToJson, testRuleAgainstHistory, type Rule, type RuleSubject, type RuleTestResult } from "@homebase/categorizer";
import { withTx, writeAudit, type Ctx, type DbLike } from "@homebase/core";
import { rules } from "@homebase/db";
import { newId } from "@homebase/shared";

export type HistorySubject = RuleSubject & { id: string; categoryId: string | null };

/**
 * Transactions a rule can act on (history preview and "apply to existing"): not deleted, not split,
 * not a transfer, not a starting balance. Newest first, capped (default two years / 20k rows).
 */
export async function loadRuleSubjects(db: DbLike, o: { sinceDays?: number; limit?: number } = {}): Promise<HistorySubject[]> {
  const res = await db.execute<{ id: string; payee_name: string | null; payee_key: string | null; raw_description: string | null; amount_milli: bigint; account_id: string; date: string; category_id: string | null }>(sql`
    SELECT t.id, p.name AS payee_name, p.normalized_key AS payee_key, t.raw_description, t.amount_milli, t.account_id, t.date, t.category_id
    FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
    WHERE t.deleted_at IS NULL AND NOT t.is_split AND t.transfer_account_id IS NULL AND NOT t.is_starting_balance
      AND t.date >= (current_date - ${o.sinceDays ?? 730}::int)
    ORDER BY t.date DESC, t.id DESC
    LIMIT ${o.limit ?? 20_000}`);
  return res.rows.map((r) => ({
    id: r.id,
    payeeName: r.payee_name,
    // Categorizer keys strip every non-alphanumeric character; the seed stored spaced keys.
    payeeKey: r.payee_key ? normalizedKey(r.payee_key) : r.payee_name ? normalizedKey(r.payee_name) : null,
    rawDescription: r.raw_description ?? r.payee_name ?? "",
    amountMilli: BigInt(r.amount_milli),
    accountId: r.account_id,
    date: r.date,
    categoryId: r.category_id,
  }));
}

export async function previewRuleAgainstHistory(db: DbLike, rule: Pick<Rule, "conditions" | "actions">): Promise<RuleTestResult> {
  return testRuleAgainstHistory(rule, await loadRuleSubjects(db));
}

export interface RuleListItem {
  id: string;
  name: string | null;
  priority: number;
  enabled: boolean;
  source: Rule["source"];
  hitCount: number;
  lastHitAt: string | null;
  rule: Pick<Rule, "conditions" | "actions"> | null;
  /** Set when the stored JSON can't be parsed (the categorizer skips such rules). */
  error: string | null;
}

export async function listRules(db: DbLike): Promise<RuleListItem[]> {
  const rows = await db.select().from(rules).orderBy(asc(rules.source), asc(rules.priority), desc(rules.hitCount));
  return rows.map((r) => {
    let rule: RuleListItem["rule"] = null;
    let error: string | null = null;
    try {
      const p = parseRule({ id: r.id, priority: r.priority, enabled: r.enabled, source: r.source, conditions: r.conditions, actions: r.actions });
      rule = { conditions: p.conditions, actions: p.actions };
    } catch (e) {
      error = e instanceof Error ? e.message.slice(0, 200) : "unreadable rule";
    }
    return { id: r.id, name: r.name, priority: r.priority, enabled: r.enabled, source: r.source, hitCount: r.hitCount, lastHitAt: r.lastHitAt?.toISOString() ?? null, rule, error };
  });
}

/** Insert a user rule in the canonical shape and audit it. */
export async function insertRule(ctx: Ctx, input: { name?: string | null; priority?: number; enabled?: boolean; rule: Pick<Rule, "conditions" | "actions"> }): Promise<string> {
  return withTx(ctx, async (tx, c) => {
    const id = newId();
    const json = ruleToJson(input.rule);
    await tx.insert(rules).values({
      id,
      name: input.name?.trim() || null,
      priority: input.priority ?? 100,
      enabled: input.enabled ?? true,
      source: "user",
      conditions: json.conditions,
      actions: json.actions,
      createdBy: c.userId,
    });
    await writeAudit(tx, c, { action: "rule.create", entity: "rule", entityId: id, after: { name: input.name ?? null, ...json } });
    return id;
  });
}

export async function updateRule(ctx: Ctx, id: string, input: { name?: string | null; priority?: number; enabled?: boolean; rule?: Pick<Rule, "conditions" | "actions"> }): Promise<void> {
  await withTx(ctx, async (tx, c) => {
    const [before] = await tx.select().from(rules).where(eq(rules.id, id));
    if (!before) throw new Error("Rule not found");
    const set: Partial<typeof rules.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) set.name = input.name?.trim() || null;
    if (input.priority !== undefined) set.priority = input.priority;
    if (input.enabled !== undefined) set.enabled = input.enabled;
    if (input.rule) {
      const json = ruleToJson(input.rule);
      set.conditions = json.conditions;
      set.actions = json.actions;
      // Editing a learned/suggested rule makes it the user's.
      if (before.source !== "user") set.source = "user";
    }
    await tx.update(rules).set(set).where(eq(rules.id, id));
    await writeAudit(tx, c, {
      action: input.rule ? "rule.update" : input.enabled !== undefined ? (input.enabled ? "rule.enable" : "rule.disable") : "rule.update",
      entity: "rule",
      entityId: id,
      before: { name: before.name, enabled: before.enabled, priority: before.priority, conditions: before.conditions, actions: before.actions },
      after: set,
    });
  });
}

export async function deleteRule(ctx: Ctx, id: string): Promise<void> {
  await withTx(ctx, async (tx, c) => {
    const [row] = await tx.delete(rules).where(eq(rules.id, id)).returning();
    if (!row) throw new Error("Rule not found");
    await writeAudit(tx, c, { action: "rule.delete", entity: "rule", entityId: id, before: { name: row.name, conditions: row.conditions, actions: row.actions } });
  });
}
