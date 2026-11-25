/**
 * Maps the Ask agent's simplified `create_rule` input onto the categorizer's canonical rule format
 * (docs/decisions.md "Categorizer: rules format"). Pure: unit-tested without a database.
 */
import { formatMilli, parseMilli } from "@homebase/shared";
import { ActionsSchema, ConditionSchema, type Rule, type RuleActions, type RuleCondition } from "@homebase/categorizer";
import type { WriteToolInput } from "@homebase/ai";
import { z } from "zod";

export type AiRuleInput = WriteToolInput<"create_rule">;

export function aiRuleToCanonical(i: AiRuleInput): Pick<Rule, "conditions" | "actions"> {
  const conditions: RuleCondition[] = [];
  if (i.payee_equals) conditions.push({ field: "payee", op: "equals", value: i.payee_equals.trim() });
  if (i.payee_contains) conditions.push({ field: "payee", op: "contains", value: i.payee_contains.trim() });
  if (i.description_contains) conditions.push({ field: "raw_description", op: "contains", value: i.description_contains.trim() });
  if (i.min_abs_amount || i.max_abs_amount) {
    conditions.push({
      field: "amount",
      op: "range",
      sign: "any",
      ...(i.min_abs_amount ? { minMilli: parseMilli(i.min_abs_amount) } : {}),
      ...(i.max_abs_amount ? { maxMilli: parseMilli(i.max_abs_amount) } : {}),
    } as RuleCondition);
  }
  if (i.account_ids?.length) conditions.push({ field: "account", op: "in", accountIds: [...i.account_ids] });
  const actions: RuleActions = {};
  if (i.category_id) actions.setCategoryId = i.category_id;
  if (i.set_payee_name) actions.setPayee = { name: i.set_payee_name.trim() };
  if (i.auto_approve) actions.autoApprove = true;
  // Validate against the categorizer's own schemas so a bad mapping can't be stored.
  return { conditions: z.array(ConditionSchema).min(1).parse(conditions), actions: ActionsSchema.parse(actions) };
}

const q = (s: string) => `“${s}”`;

/** One-line description of a canonical rule, for Settings → Rules and confirmation cards. */
export function describeRule(rule: Pick<Rule, "conditions" | "actions">, names: { category?: (id: string) => string | undefined; account?: (id: string) => string | undefined } = {}): { when: string; then: string } {
  const when = rule.conditions.map((c) => {
    switch (c.field) {
      case "payee":
      case "raw_description": {
        const f = c.field === "payee" ? "payee" : "description";
        return c.op === "equals" ? `${f} is ${q(c.value)}` : c.op === "contains" ? `${f} contains ${q(c.value)}` : `${f} matches /${c.value}/`;
      }
      case "amount": {
        const sign = c.sign === "outflow" ? " (outflow)" : c.sign === "inflow" ? " (inflow)" : "";
        if (c.op === "equals") return `amount is ${formatMilli(c.valueMilli, { sign: "never" })}${sign}`;
        const lo = c.minMilli !== undefined ? formatMilli(c.minMilli, { sign: "never" }) : null;
        const hi = c.maxMilli !== undefined ? formatMilli(c.maxMilli, { sign: "never" }) : null;
        return `${lo && hi ? `amount ${lo}–${hi}` : lo ? `amount ≥ ${lo}` : `amount ≤ ${hi}`}${sign}`;
      }
      case "account":
        return `account is ${c.accountIds.map((id) => names.account?.(id) ?? "an account").join(" or ")}`;
      case "day_of_month":
        return `day of month ${c.from}–${c.to}`;
    }
  });
  const a = rule.actions;
  const then: string[] = [];
  if (a.setCategoryId) then.push(`category ${names.category?.(a.setCategoryId) ?? "(deleted category)"}`);
  if (a.split) then.push(`split ${a.split.lines.length} ways`);
  if (a.transferAccountId) then.push(`transfer with ${names.account?.(a.transferAccountId) ?? "an account"}`);
  if (a.setPayee?.name) then.push(`rename to ${q(a.setPayee.name)}`);
  if (a.setMemo) then.push(`memo ${q(a.setMemo)}`);
  if (a.autoApprove) then.push("auto-approve");
  return { when: when.join(" and "), then: then.join(", ") || "no action" };
}
