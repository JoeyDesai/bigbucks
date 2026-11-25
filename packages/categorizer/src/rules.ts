/**
 * Rules (§5.2, §9.1 step 2): conditions → actions, user rules before learned rules.
 *
 * Stored JSON (rules.conditions / rules.actions) keeps milliunits as decimal strings; `parseRule`
 * validates with Zod and converts to bigint. Amount conditions compare absolute values, with an
 * optional sign filter, because people think "Netflix is $15.49", not "−15490".
 */
import { z } from "zod";
import { absMilli, type ISODate, type Milli } from "@homebase/shared";
import { normalizedKey } from "./normalize";
import type { SplitLine } from "./types";

const MilliJson = z.union([z.string().regex(/^-?\d+$/), z.number().int(), z.bigint()]).transform((v) => BigInt(v));
const Sign = z.enum(["outflow", "inflow", "any"]);

/** "33.33" → 3333 basis points; no floats. */
export function percentToBps(p: string | number): number {
  const s = typeof p === "number" ? p.toFixed(2) : p.trim();
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`invalid percent ${p}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export const ConditionSchema = z.union([
  z.object({ field: z.enum(["payee", "raw_description"]), op: z.enum(["equals", "contains", "regex"]), value: z.string().min(1).max(200) }),
  z.object({ field: z.literal("amount"), op: z.literal("equals"), valueMilli: MilliJson, sign: Sign.default("any") }),
  z
    .object({ field: z.literal("amount"), op: z.literal("range"), minMilli: MilliJson.optional(), maxMilli: MilliJson.optional(), sign: Sign.default("any") })
    .refine((c) => c.minMilli !== undefined || c.maxMilli !== undefined, "range needs min or max"),
  z.object({ field: z.literal("account"), op: z.literal("in"), accountIds: z.array(z.string()).min(1) }),
  z.object({ field: z.literal("day_of_month"), op: z.literal("range"), from: z.number().int().min(1).max(31), to: z.number().int().min(1).max(31) }),
]);
export type RuleCondition = z.infer<typeof ConditionSchema>;

const PercentLine = z.object({
  categoryId: z.string(),
  percent: z.union([z.string(), z.number()]).transform((p) => percentToBps(p)),
  memo: z.string().optional(),
});
const FixedLine = z.object({ categoryId: z.string(), amountMilli: MilliJson.optional(), remainder: z.boolean().optional(), memo: z.string().optional() });

export const SplitTemplateSchema = z.union([
  z
    .object({ mode: z.literal("percent"), lines: z.array(PercentLine).min(2) })
    .refine((t) => t.lines.reduce((a, l) => a + l.percent, 0) === 10_000, "percent lines must add up to 100"),
  z
    .object({ mode: z.literal("fixed"), lines: z.array(FixedLine).min(2) })
    .refine((t) => t.lines.filter((l) => l.remainder).length <= 1, "at most one remainder line")
    .refine((t) => t.lines.every((l) => l.remainder || (l.amountMilli !== undefined && l.amountMilli >= 0n)), "fixed lines need a non-negative amount"),
]);
export type SplitTemplate = z.infer<typeof SplitTemplateSchema>;

export const ActionsSchema = z.object({
  setPayee: z.object({ payeeId: z.string().optional(), name: z.string().optional() }).optional(),
  setCategoryId: z.string().optional(),
  setMemo: z.string().optional(),
  split: SplitTemplateSchema.optional(),
  transferAccountId: z.string().optional(),
  autoApprove: z.boolean().optional(),
});
export type RuleActions = z.infer<typeof ActionsSchema>;

export type RuleSource = "user" | "learned" | "ai_suggested";

export interface Rule {
  id: string;
  name?: string | null;
  priority: number;
  enabled: boolean;
  source: RuleSource;
  conditions: RuleCondition[];
  actions: RuleActions;
  hitCount?: number;
  lastHitAt?: string | null;
  createdBy?: string | null;
}

/** A DB row with raw JSON columns. */
export interface RuleRow {
  id: string;
  name?: string | null;
  priority: number;
  enabled: boolean;
  source: RuleSource;
  conditions: unknown;
  actions: unknown;
  hitCount?: number;
  lastHitAt?: string | null;
  createdBy?: string | null;
}

/**
 * Accept the provisional shape the demo seed was written with and translate it to the canonical one:
 *   conditions `{ all: [...] }` → array; `{field: "amount_milli", op: lte|lt|gte|gt|eq, value}` → amount
 *   conditions (signed thresholds only); actions `[{type: set_category|approve|set_payee|set_memo|mark_transfer}]`
 *   → the actions object. Anything it can't express exactly throws (the rule is then skipped by the repo).
 */
export function normalizeLegacyRuleJson(conditions: unknown, actions: unknown): { conditions: unknown; actions: unknown } {
  let conds = conditions;
  if (conds && typeof conds === "object" && !Array.isArray(conds)) {
    const o = conds as { all?: unknown; any?: unknown };
    if (o.any !== undefined) throw new Error("`any` rule conditions are not supported");
    if (Array.isArray(o.all)) conds = o.all;
  }
  if (Array.isArray(conds)) {
    conds = conds.map((c: unknown) => {
      const x = c as { field?: string; op?: string; value?: unknown };
      if (x?.field !== "amount_milli") return c;
      const v = BigInt(String(x.value));
      const abs = v < 0n ? -v : v;
      switch (x.op) {
        case "eq":
        case "equals":
          return { field: "amount", op: "equals", valueMilli: abs.toString(), sign: v < 0n ? "outflow" : v > 0n ? "inflow" : "any" };
        case "lte":
        case "lt":
          if (v > 0n) throw new Error("amount_milli lte/lt with a positive value can't be expressed");
          return { field: "amount", op: "range", minMilli: (x.op === "lt" ? abs + 1n : abs).toString(), sign: "outflow" };
        case "gte":
        case "gt":
          if (v < 0n) throw new Error("amount_milli gte/gt with a negative value can't be expressed");
          return { field: "amount", op: "range", minMilli: (x.op === "gt" ? abs + 1n : abs).toString(), sign: "inflow" };
        default:
          throw new Error(`unsupported amount_milli op ${String(x.op)}`);
      }
    });
  }
  let acts = actions;
  if (Array.isArray(acts)) {
    const out: Record<string, unknown> = {};
    for (const a of acts as { type?: string; [k: string]: unknown }[]) {
      switch (a?.type) {
        case "set_category":
          out.setCategoryId = a.category_id;
          break;
        case "approve":
        case "auto_approve":
          out.autoApprove = true;
          break;
        case "set_payee":
          out.setPayee = { ...(a.payee_id ? { payeeId: a.payee_id } : {}), ...(a.name ? { name: a.name } : {}) };
          break;
        case "set_memo":
          out.setMemo = a.memo;
          break;
        case "mark_transfer":
          out.transferAccountId = a.account_id;
          break;
        default:
          throw new Error(`unsupported rule action ${String(a?.type)}`);
      }
    }
    acts = out;
  }
  return { conditions: conds, actions: acts };
}

export function parseRule(row: RuleRow): Rule {
  const norm = normalizeLegacyRuleJson(row.conditions, row.actions);
  const conditions = z.array(ConditionSchema).min(1).parse(norm.conditions);
  const actions = ActionsSchema.parse(norm.actions);
  return { ...row, conditions, actions };
}

/** Serialize conditions/actions for storage (bigint → string, bps → percent string). */
export function ruleToJson(rule: Pick<Rule, "conditions" | "actions">): { conditions: unknown; actions: unknown } {
  const j = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x)));
  const actions = { ...rule.actions } as Record<string, unknown>;
  if (rule.actions.split?.mode === "percent") {
    actions.split = { mode: "percent", lines: rule.actions.split.lines.map((l) => ({ ...l, percent: `${Math.floor(l.percent / 100)}.${String(l.percent % 100).padStart(2, "0")}` })) };
  }
  return { conditions: j(rule.conditions), actions: j(actions) };
}

/** The fields rules can see. */
export interface RuleSubject {
  payeeName: string | null;
  payeeKey: string | null;
  rawDescription: string;
  amountMilli: Milli;
  accountId: string;
  date: ISODate;
}

const upper = (s: string) => s.toUpperCase().replace(/\s+/g, " ").trim();

function safeRegex(pattern: string): RegExp | null {
  if (pattern.length > 200) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

function signOk(sign: "outflow" | "inflow" | "any", amount: Milli): boolean {
  return sign === "any" || (sign === "outflow" ? amount < 0n : amount > 0n);
}

export function conditionMatches(c: RuleCondition, s: RuleSubject): boolean {
  switch (c.field) {
    case "payee": {
      const name = s.payeeName ?? "";
      if (c.op === "equals") return (s.payeeKey ?? normalizedKey(name)) === normalizedKey(c.value) && normalizedKey(c.value) !== "";
      if (c.op === "contains") return upper(name).includes(upper(c.value));
      return safeRegex(c.value)?.test(name) ?? false;
    }
    case "raw_description": {
      if (c.op === "equals") return upper(s.rawDescription) === upper(c.value);
      if (c.op === "contains") return upper(s.rawDescription).includes(upper(c.value));
      return safeRegex(c.value)?.test(s.rawDescription) ?? false;
    }
    case "amount": {
      if (!signOk(c.sign, s.amountMilli)) return false;
      const a = absMilli(s.amountMilli);
      if (c.op === "equals") return a === absMilli(c.valueMilli);
      if (c.minMilli !== undefined && a < absMilli(c.minMilli)) return false;
      if (c.maxMilli !== undefined && a > absMilli(c.maxMilli)) return false;
      return true;
    }
    case "account":
      return c.accountIds.includes(s.accountId);
    case "day_of_month": {
      const d = Number(s.date.slice(8, 10));
      return c.from <= c.to ? d >= c.from && d <= c.to : d >= c.from || d <= c.to; // wraps (28..3)
    }
  }
}

/** All conditions must hold. */
export function ruleMatches(rule: Rule, s: RuleSubject): boolean {
  return rule.conditions.length > 0 && rule.conditions.every((c) => conditionMatches(c, s));
}

const SOURCE_ORDER: Record<RuleSource, number> = { user: 0, learned: 1, ai_suggested: 2 };

/** Enabled rules in evaluation order: user before learned, then priority, then id. ai_suggested rules are proposals only. */
export function orderRules(rules: readonly Rule[]): Rule[] {
  return rules
    .filter((r) => r.enabled && r.source !== "ai_suggested")
    .slice()
    .sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Split an amount by a template with exact milliunit totals. Allocation is in cents when the
 * amount is a whole number of cents, otherwise in milliunits; leftover units go to the lines with
 * the largest fractional remainder (ties: earlier line).
 */
export function applySplitTemplate(amount: Milli, t: SplitTemplate): SplitLine[] | { error: string } {
  const sign = amount < 0n ? -1n : 1n;
  const abs = absMilli(amount);
  if (t.mode === "percent") {
    const unit = abs % 10n === 0n ? 10n : 1n;
    const units = abs / unit;
    const raw = t.lines.map((l) => units * BigInt(l.percent));
    const base = raw.map((r) => r / 10_000n);
    let left = units - base.reduce((a, b) => a + b, 0n);
    const order = raw.map((r, i) => ({ i, rem: r % 10_000n })).sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.i - b.i));
    for (const o of order) {
      if (left <= 0n) break;
      base[o.i]! += 1n;
      left -= 1n;
    }
    return t.lines.map((l, i) => ({ categoryId: l.categoryId, amountMilli: sign * base[i]! * unit, ...(l.memo ? { memo: l.memo } : {}) }));
  }
  const remIdx = t.lines.findIndex((l) => l.remainder);
  const restIdx = remIdx === -1 ? t.lines.length - 1 : remIdx;
  const fixedSum = t.lines.reduce((a, l, i) => (i === restIdx ? a : a + absMilli(l.amountMilli ?? 0n)), 0n);
  const rest = abs - fixedSum;
  if (rest < 0n) return { error: "fixed split lines exceed the transaction amount" };
  return t.lines.map((l, i) => ({
    categoryId: l.categoryId,
    amountMilli: sign * (i === restIdx ? rest : absMilli(l.amountMilli ?? 0n)),
    ...(l.memo ? { memo: l.memo } : {}),
  }));
}

export interface RuleOutcome {
  matchedRuleIds: string[];
  /** Rule that decided the category / split / transfer. */
  decidingRuleId: string | null;
  decidingSource: RuleSource | null;
  payee?: { payeeId?: string; name?: string };
  categoryId?: string;
  memo?: string;
  split?: SplitLine[];
  transferAccountId?: string;
  autoApprove?: boolean;
  errors: string[];
}

/**
 * Evaluate rules in order. Each action field is taken from the first matching rule that sets it,
 * so a high-priority "rename payee" rule can combine with a later "set category" rule. The first
 * rule supplying a category, split or transfer is the deciding rule.
 */
export function applyRules(rules: readonly Rule[], s: RuleSubject): RuleOutcome {
  const out: RuleOutcome = { matchedRuleIds: [], decidingRuleId: null, decidingSource: null, errors: [] };
  for (const r of orderRules(rules)) {
    if (!ruleMatches(r, s)) continue;
    out.matchedRuleIds.push(r.id);
    const a = r.actions;
    if (a.setPayee && !out.payee) out.payee = a.setPayee;
    if (a.setMemo !== undefined && out.memo === undefined) out.memo = a.setMemo;
    if (a.autoApprove !== undefined && out.autoApprove === undefined) out.autoApprove = a.autoApprove;
    if (out.decidingRuleId) continue;
    if (a.transferAccountId) {
      out.transferAccountId = a.transferAccountId;
    } else if (a.split) {
      const lines = applySplitTemplate(s.amountMilli, a.split);
      if ("error" in lines) {
        out.errors.push(`rule ${r.id}: ${lines.error}`);
        continue;
      }
      out.split = lines;
    } else if (a.setCategoryId) {
      out.categoryId = a.setCategoryId;
    } else continue;
    out.decidingRuleId = r.id;
    out.decidingSource = r.source;
  }
  return out;
}

export interface RuleTestResult {
  matchCount: number;
  /** Matches whose current category differs from what the rule would set. */
  wouldChangeCount: number;
  sampleIds: string[];
}

/** Settings → Rules "test against history" preview (N matches). */
export function testRuleAgainstHistory(rule: Pick<Rule, "conditions" | "actions">, history: readonly (RuleSubject & { id: string; categoryId: string | null })[], sampleSize = 20): RuleTestResult {
  const asRule: Rule = { id: "__test", priority: 0, enabled: true, source: "user", ...rule };
  let matchCount = 0;
  let wouldChangeCount = 0;
  const sampleIds: string[] = [];
  for (const h of history) {
    if (!ruleMatches(asRule, h)) continue;
    matchCount++;
    if (rule.actions.setCategoryId !== undefined && h.categoryId !== rule.actions.setCategoryId) wouldChangeCount++;
    if (sampleIds.length < sampleSize) sampleIds.push(h.id);
  }
  return { matchCount, wouldChangeCount, sampleIds };
}
