"use server";
/**
 * Settings actions any household member may use (§2): memory, categories & groups, payees, rules,
 * accounts. Every write goes through @homebase/core (audited) or the rules helpers (audited).
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { CUSTOM_ACCENT_RE, USER_ACCENTS } from "@homebase/shared";
import * as core from "@homebase/core";
import { ActionsSchema, ConditionSchema, testRuleAgainstHistory } from "@homebase/categorizer";
import { getDb } from "@/server/db";
import { act, UserFacingError } from "../act";
import { deleteRule, insertRule, loadRuleSubjects, updateRule } from "../rules";

const Id = z.string().uuid();

// ── household memory ────────────────────────────────────────────────────────

export async function addMemoryAction(text: string) {
  return act("memory.add", { revalidate: "/settings/memory" }, async ({ ctx }) => {
    const m = await core.addMemory(ctx, z.string().trim().min(3, "Write at least a few words").max(500).parse(text));
    return { id: m.id };
  });
}
export async function updateMemoryAction(id: string, text: string) {
  return act("memory.update", { revalidate: "/settings/memory" }, async ({ ctx }) => {
    await core.updateMemory(ctx, Id.parse(id), z.string().trim().min(3).max(500).parse(text));
    return {};
  });
}
export async function deleteMemoryAction(id: string) {
  return act("memory.delete", { revalidate: "/settings/memory" }, async ({ ctx }) => {
    await core.deleteMemory(ctx, Id.parse(id));
    return {};
  });
}

// ── categories & groups ─────────────────────────────────────────────────────

const CAT = "/settings/categories";
const Name = z.string().trim().min(1, "Enter a name").max(100);

export async function createGroupAction(name: string) {
  return act("group.create", { revalidate: [CAT, "/plan"] }, async ({ ctx }) => ({ id: (await core.createGroup(ctx, { name: Name.parse(name) })).entityId }));
}
export async function createCategoryAction(groupId: string, name: string) {
  return act("category.create", { revalidate: [CAT, "/plan"] }, async ({ ctx }) => ({ id: (await core.createCategory(ctx, { groupId: Id.parse(groupId), name: Name.parse(name) })).entityId }));
}
export async function renameCategoryAction(id: string, name: string) {
  return act("category.rename", { revalidate: CAT }, async ({ ctx }) => {
    await core.renameCategory(ctx, Id.parse(id), Name.parse(name));
    return {};
  });
}
export async function renameGroupAction(id: string, name: string) {
  return act("group.rename", { revalidate: CAT }, async ({ ctx }) => {
    await core.renameGroup(ctx, Id.parse(id), Name.parse(name));
    return {};
  });
}
export async function setCategoryHiddenAction(id: string, hidden: boolean) {
  return act("category.hide", { revalidate: CAT }, async ({ ctx }) => {
    await core.setCategoryHidden(ctx, Id.parse(id), hidden);
    return {};
  });
}
export async function setGroupHiddenAction(id: string, hidden: boolean) {
  return act("group.hide", { revalidate: CAT }, async ({ ctx }) => {
    await core.setGroupHidden(ctx, Id.parse(id), hidden);
    return {};
  });
}
export async function reorderCategoriesAction(groupId: string, categoryIds: string[]) {
  return act("category.reorder", { revalidate: CAT }, async ({ ctx }) => {
    await core.reorderCategories(ctx, { groupId: Id.parse(groupId), categoryIds: z.array(Id).parse(categoryIds) });
    return {};
  });
}
export async function reorderGroupsAction(groupIds: string[]) {
  return act("group.reorder", { revalidate: CAT }, async ({ ctx }) => {
    await core.reorderGroups(ctx, z.array(Id).parse(groupIds));
    return {};
  });
}
export async function mergeCategoriesAction(sourceId: string, targetId: string) {
  return act("category.merge", { revalidate: CAT }, async ({ ctx }) => {
    const r = await core.mergeCategories(ctx, { sourceId: Id.parse(sourceId), targetId: Id.parse(targetId) });
    return { transactions: r.transactions, splits: r.splits, sourceName: r.sourceName, targetName: r.targetName };
  });
}
export async function setAlwaysReviewAction(id: string, alwaysReview: boolean) {
  return act("category.always_review", { revalidate: ["/settings/ai", CAT] }, async ({ ctx }) => {
    await core.updateCategory(ctx, Id.parse(id), { alwaysReview });
    return {};
  });
}

// ── payees ──────────────────────────────────────────────────────────────────

const PAY = "/settings/payees";

export async function renamePayeeAction(id: string, name: string) {
  return act("payee.rename", { revalidate: PAY }, async ({ ctx }) => {
    await core.renamePayee(ctx, Id.parse(id), z.string().trim().min(1).max(200).parse(name));
    return {};
  });
}
export async function setPayeeDefaultCategoryAction(id: string, categoryId: string | null) {
  return act("payee.default_category", { revalidate: PAY }, async ({ ctx }) => {
    await core.setPayeeDefaultCategory(ctx, Id.parse(id), categoryId ? Id.parse(categoryId) : null);
    return {};
  });
}
export async function mergePayeesAction(sourceIds: string[], targetId: string) {
  return act("payee.merge", { revalidate: PAY }, async ({ ctx }) => {
    const r = await core.mergePayees(ctx, { sourceIds: z.array(Id).min(1).parse(sourceIds), targetId: Id.parse(targetId) });
    return { moved: r.moved };
  });
}
export async function createAliasAction(payeeId: string, pattern: string, match: "exact" | "prefix" | "regex") {
  return act("payee.alias_create", { revalidate: PAY }, async ({ ctx }) => {
    const a = await core.createAlias(ctx, { payeeId: Id.parse(payeeId), pattern, match });
    return { id: a.id };
  });
}
export async function deleteAliasAction(id: string) {
  return act("payee.alias_delete", { revalidate: PAY }, async ({ ctx }) => {
    await core.deleteAlias(ctx, Id.parse(id));
    return {};
  });
}
export async function getPayeeDetailAction(id: string) {
  return act("payee.get", {}, async () => {
    const p = await core.getPayee(getDb(), Id.parse(id));
    return {
      payee: {
        id: p.id,
        name: p.name,
        defaultCategoryId: p.defaultCategoryId,
        merchant: p.merchant ? { type: p.merchant.type, description: p.merchant.description, website: p.merchant.website ?? null, location: p.merchant.location ?? null, lookedUpAt: p.merchant.looked_up_at, found: (p.merchant as { found?: boolean }).found !== false } : null,
        aliases: p.aliases.map((a) => ({ id: a.id, pattern: a.pattern, match: a.match })),
      },
    };
  });
}

// ── rules ───────────────────────────────────────────────────────────────────

const RULES = "/settings/rules";
/** Rule JSON as the builder sends it (milli as decimal strings). */
const RuleInput = z.object({
  name: z.string().trim().max(120).nullable().optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  conditions: z.array(ConditionSchema).min(1, "Add at least one condition"),
  actions: ActionsSchema,
});

function parseRuleInput(input: unknown) {
  const r = RuleInput.parse(input);
  const a = r.actions;
  if (!a.setCategoryId && !a.setPayee?.name && !a.setMemo && !a.autoApprove && !a.split && !a.transferAccountId) throw new UserFacingError("Add at least one action.");
  return r;
}

export async function testRuleAction(input: unknown) {
  return act("rule.test", {}, async () => {
    const r = parseRuleInput(input);
    const history = await loadRuleSubjects(getDb());
    const t = testRuleAgainstHistory({ conditions: r.conditions, actions: r.actions }, history, 8);
    const byId = new Map(history.map((h) => [h.id, h]));
    return {
      matchCount: t.matchCount,
      wouldChangeCount: t.wouldChangeCount,
      sample: t.sampleIds.map((id) => {
        const h = byId.get(id)!;
        return { id, date: h.date, payee: h.payeeName ?? h.rawDescription, amount: h.amountMilli.toString() };
      }),
    };
  });
}

export async function saveRuleAction(id: string | null, input: unknown) {
  return act("rule.save", { revalidate: RULES }, async ({ ctx }) => {
    const r = parseRuleInput(input);
    const rule = { conditions: r.conditions, actions: r.actions };
    if (id) {
      await updateRule(ctx, Id.parse(id), { name: r.name ?? null, ...(r.priority !== undefined ? { priority: r.priority } : {}), rule });
      return { id };
    }
    return { id: await insertRule(ctx, { name: r.name ?? null, ...(r.priority !== undefined ? { priority: r.priority } : {}), rule }) };
  });
}

export async function setRuleEnabledAction(id: string, enabled: boolean) {
  return act("rule.enable", { revalidate: RULES }, async ({ ctx }) => {
    await updateRule(ctx, Id.parse(id), { enabled });
    return {};
  });
}

export async function deleteRuleAction(id: string) {
  return act("rule.delete", { revalidate: RULES }, async ({ ctx }) => {
    await deleteRule(ctx, Id.parse(id));
    return {};
  });
}

// ── accounts ────────────────────────────────────────────────────────────────

const AccountPatch = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  nickname: z.string().trim().max(100).nullable().optional(),
  institution: z.string().trim().max(100).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
  statementDueDay: z.number().int().min(1).max(31).nullable().optional(),
  /** Decimal milli string. */
  monthlyContribution: z.string().regex(/^\d+$/).nullable().optional(),
  closed: z.boolean().optional(),
});

export async function updateAccountAction(id: string, patch: unknown) {
  return act("account.update", { revalidate: ["/settings/accounts", "/activity", "/wealth", "/investments"] }, async ({ ctx }) => {
    const p = AccountPatch.parse(patch);
    await core.updateAccount(ctx, Id.parse(id), {
      ...p,
      ...(p.nickname !== undefined ? { nickname: p.nickname || null } : {}),
      ...(p.monthlyContribution !== undefined ? { monthlyContribution: p.monthlyContribution === null ? null : BigInt(p.monthlyContribution) } : {}),
    });
    return {};
  });
}

// ── profile ─────────────────────────────────────────────────────────────────

/** Each person picks their own accent color (sidebar highlight, buttons, links, charts). */
export async function setMyAccentAction(accent: string | null) {
  return act("user.accent", { revalidate: [] }, async ({ ctx, user }) => {
    const v = z.union([z.enum(USER_ACCENTS), z.string().regex(CUSTOM_ACCENT_RE).transform((x) => x as `#${string}`)]).nullable().parse(accent?.toLowerCase() ?? null);
    await core.setUserAccent(ctx, user.id, v);
    revalidatePath("/", "layout");
    return {};
  });
}
