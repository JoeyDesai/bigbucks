import { eq } from "drizzle-orm";
import { getSetting, listCategories } from "@homebase/core";
import { settings } from "@homebase/db";
import { requireAdmin } from "@/server/auth";
import { getDb } from "@/server/db";
import { ANTHROPIC_KEY_SETTING, getAiStatus } from "@/server/ai/client";
import { accuracyByMonth, usageByModelThisMonth, usageByMonth } from "@/server/settings/aiStats";
import { SettingsFrame } from "@/components/settings/SettingsFrame";
import { AiSettings } from "@/components/settings/AiSettings";

export const metadata = { title: "AI" };
export const dynamic = "force-dynamic";

export default async function Page() {
  await requireAdmin();
  const db = getDb();
  const status = await getAiStatus(db);
  const [models, budget, policy] = [await getSetting(db, "ai_models"), await getSetting(db, "ai_budget"), await getSetting(db, "approval_policy")];
  const [keyRow] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, ANTHROPIC_KEY_SETTING));
  const [usage, byModel, accuracy, groups] = [await usageByMonth(db), await usageByModelThisMonth(db), await accuracyByMonth(db), await listCategories(db, { includeHidden: false })];
  const cats = groups.flatMap((g) =>
    g.categories
      .filter((c) => c.kind === "normal" || c.kind === "uncategorized" || c.kind === "internal_rta")
      .map((c) => ({ id: c.id, name: c.name, group: g.name, alwaysReview: c.alwaysReview, defaultReview: c.kind === "uncategorized" || /\bmisc\b/i.test(c.name) || /savings/i.test(c.name) || /savings/i.test(g.name) })),
  );
  return (
    <SettingsFrame admin title="AI" wide intro="The Anthropic key, monthly cap, model ids, when categorized transactions are approved on their own, and how well suggestions are doing.">
      <AiSettings
        key_={{ source: status.keySource, last4: ((keyRow?.value ?? null) as { last4?: string } | null)?.last4 ?? null, ...(status.keyError ? { error: status.keyError } : {}) }}
        models={models}
        budget={budget}
        policy={policy}
        spentMicro={status.spentMicroUsd.toString()}
        capMicro={status.capMicroUsd.toString()}
        usage={usage}
        byModel={byModel}
        accuracy={accuracy}
        categories={cats}
        anyFlagged={cats.some((c) => c.alwaysReview)}
      />
    </SettingsFrame>
  );
}
