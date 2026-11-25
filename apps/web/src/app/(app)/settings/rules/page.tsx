import { listAccounts, listCategories } from "@homebase/core";
import { ruleToJson } from "@homebase/categorizer";
import { requireUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { describeRule } from "@/server/ai/rules";
import { listRules } from "@/server/settings/rules";
import { SettingsFrame } from "@/components/settings/SettingsFrame";
import { RulesEditor, type RuleJson } from "@/components/settings/RulesEditor";

export const metadata = { title: "Rules" };
export const dynamic = "force-dynamic";

export default async function Page() {
  await requireUser();
  const db = getDb();
  const [rules, groups, accounts] = [await listRules(db), await listCategories(db, { includeHidden: true }), await listAccounts(db)];
  const catName = new Map(groups.flatMap((g) => g.categories.map((c) => [c.id, c.name] as const)));
  const acctName = new Map(accounts.map((a) => [a.id, a.displayName] as const));
  const categories = groups.flatMap((g) => g.categories.filter((c) => !c.hidden && (c.kind === "normal" || c.kind === "internal_rta")).map((c) => ({ id: c.id, label: `${g.name} · ${c.name}` })));
  return (
    <SettingsFrame title="Rules" intro="Rules run before history and AI: your rules first, then learned ones, by priority. Each action comes from the first matching rule that sets it. Test a rule against the last two years before you save it.">
      <RulesEditor
        categories={categories}
        accounts={accounts.map((a) => ({ id: a.id, label: a.displayName }))}
        rules={rules.map((r) => {
          const d = r.rule ? describeRule(r.rule, { category: (id) => catName.get(id), account: (id) => acctName.get(id) }) : { when: "", then: "" };
          return { id: r.id, name: r.name, priority: r.priority, enabled: r.enabled, source: r.source, hitCount: r.hitCount, lastHitAt: r.lastHitAt, when: d.when, then: d.then, json: r.rule ? (ruleToJson(r.rule) as RuleJson) : null, error: r.error };
        })}
      />
    </SettingsFrame>
  );
}
