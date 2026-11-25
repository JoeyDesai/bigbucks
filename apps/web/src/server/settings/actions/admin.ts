"use server";
/**
 * Admin-only Settings actions (§2: Connections, Users, AI, Backups). Members get a 404 from
 * requireAdmin(). Every change writes audit_log; secrets are encrypted and never returned.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import * as core from "@homebase/core";
import { settings } from "@homebase/db";
import { getDb } from "@/server/db";
import { hashPassword } from "@/server/auth";
import { PASSWORD_MAX, PASSWORD_MIN, isValidPasswordFormat } from "@/server/identity/pin-policy";
import { ANTHROPIC_KEY_SETTING } from "@/server/ai/client";
import { act, UserFacingError } from "../act";
import { addOrRotateConnection, testConnection, setConnectionDisabled, type CredentialInput } from "../connections";
import { setVapidSubject } from "../push";

const AI = "/settings/ai";

// ── AI ──────────────────────────────────────────────────────────────────────

const ModelId = z.string().trim().regex(/^[a-z0-9][a-z0-9._:\-[\]]{2,80}$/i, "Model ids look like claude-sonnet-5-5");

export async function saveAiModelsAction(input: { chat: string; deep: string; categorize: string; merchant_lookup: string; digest: string }) {
  return act("settings.ai_models", { admin: true, revalidate: [AI, "/ask"] }, async ({ ctx }) => {
    const v = z.object({ chat: ModelId, deep: ModelId, categorize: ModelId, merchant_lookup: ModelId, digest: ModelId }).parse(input);
    await core.setSetting(ctx, "ai_models", v);
    return {};
  });
}

export async function saveAiBudgetAction(input: { monthly_cap_usd: number; warn_at_fraction: number; web_lookup_enabled: boolean }) {
  return act("settings.ai_budget", { admin: true, revalidate: [AI, "/ask"] }, async ({ ctx }) => {
    const v = z.object({ monthly_cap_usd: z.number().min(0).max(1000), warn_at_fraction: z.number().min(0.1).max(1), web_lookup_enabled: z.boolean() }).parse(input);
    await core.setSetting(ctx, "ai_budget", v);
    return {};
  });
}

const Conf = z.number().min(0.5).max(1);
const MilliStr = z.string().regex(/^\d+$/);
export async function saveApprovalPolicyAction(input: unknown) {
  return act("settings.approval_policy", { admin: true, revalidate: AI }, async ({ ctx }) => {
    const v = z
      .object({
        auto_approve_rule_history_min_confidence: Conf,
        auto_approve_ai_min_confidence: Conf,
        auto_approve_ai_max_abs_milli: MilliStr,
        auto_categorize_min_confidence: Conf,
        income_review_over_milli: MilliStr,
        income_review_first_n: z.number().int().min(0).max(100),
      })
      .parse(input);
    if (v.auto_categorize_min_confidence > v.auto_approve_ai_min_confidence) throw new UserFacingError("The auto-categorize threshold can't be above the auto-approve threshold.");
    await core.setSetting(ctx, "approval_policy", v);
    return {};
  });
}

export async function setAnthropicKeyAction(key: string) {
  return act("settings.anthropic_key", { admin: true, revalidate: [AI, "/ask", "/settings/connections"] }, async ({ ctx }) => {
    const k = key.trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) throw new UserFacingError("That doesn't look like an Anthropic API key (it starts with sk-ant-).");
    const r = await core.setSecretSetting(ctx, ANTHROPIC_KEY_SETTING, k);
    return { last4: r.last4 };
  });
}

export async function clearAnthropicKeyAction() {
  return act("settings.anthropic_key_clear", { admin: true, revalidate: [AI, "/ask", "/settings/connections"] }, async ({ ctx }) => {
    await core.withTx(ctx, async (tx, c) => {
      const rows = await tx.delete(settings).where(eq(settings.key, ANTHROPIC_KEY_SETTING)).returning({ key: settings.key });
      if (rows.length) await core.writeAudit(tx, c, { action: "settings.clear_secret", entity: "setting", entityId: ANTHROPIC_KEY_SETTING });
    });
    return {};
  });
}

// ── users & passwords ───────────────────────────────────────────────────────

export async function setUserPasswordAction(userId: string, password: string | null) {
  return act("user.password", { admin: true, revalidate: "/settings/users" }, async ({ ctx }) => {
    const id = z.string().uuid().parse(userId);
    if (password !== null && !isValidPasswordFormat(password)) throw new UserFacingError(`A password is ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`);
    // argon2id via the identity helper; core revokes that user's sessions and audits the change.
    await core.setPasswordHash(ctx, id, password === null ? null : await hashPassword(password));
    return {};
  });
}

export async function setUsernameAction(userId: string, username: string) {
  return act("user.username", { admin: true, revalidate: "/settings/users" }, async ({ ctx }) => {
    const u = await core.setUsername(ctx, z.string().uuid().parse(userId), z.string().max(100).parse(username));
    return { username: u.username };
  });
}

// ── notifications (admin part) ──────────────────────────────────────────────

export async function setVapidSubjectAction(subject: string) {
  return act("settings.vapid_subject", { admin: true, revalidate: "/settings/notifications" }, async ({ ctx }) => {
    try {
      await setVapidSubject(ctx, subject.trim());
    } catch (e) {
      throw new UserFacingError((e as Error).message);
    }
    return {};
  });
}

// ── connections ─────────────────────────────────────────────────────────────

const CONN = "/settings/connections";

export async function saveConnectionCredentialsAction(input: CredentialInput) {
  return act("connection.credentials", { admin: true, revalidate: CONN }, async ({ ctx }) => {
    const r = await addOrRotateConnection(getDb(), ctx, input);
    return { id: r.id, last4: r.last4 };
  });
}

export async function testConnectionAction(id: string) {
  return act("connection.test", { admin: true, revalidate: CONN }, async ({ ctx }) => {
    const r = await testConnection(getDb(), ctx, z.string().uuid().parse(id));
    return { result: r };
  });
}

export async function setConnectionDisabledAction(id: string, disabled: boolean) {
  return act("connection.disable", { admin: true, revalidate: CONN }, async ({ ctx }) => {
    await setConnectionDisabled(ctx, z.string().uuid().parse(id), disabled);
    return {};
  });
}
