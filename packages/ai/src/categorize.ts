/**
 * §9.3 real-time categorization call: Haiku + structured outputs.
 *
 * Prompt layout (cache-friendly, stable first):
 *   system[0] static instructions
 *   system[1] category catalog + household memory   ← cache_control breakpoint (≥512 tokens total)
 *   user      the transaction + up to 15 similar past transactions (volatile)
 *
 * The same request builder and parser are used for the Message Batches path (categorizer/batch).
 */
import { z } from "zod";
import { formatMilli, weekday, sumMilli, type Milli } from "@homebase/shared";
import type { AiClient, BetaCreateParams, BetaMessage, BetaTextBlockParam } from "./client";
import { textOf } from "./client";
import { redactDigits } from "./redact";
import { computeCost } from "./usage";
import type { PriceTable } from "./models";
import type { CatalogCategory, CategorizeTxn, SimilarTxn } from "./types";

export const MAX_SIMILAR = 15;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface CategorizeInput {
  catalog: CatalogCategory[];
  householdMemory: string[];
  transaction: CategorizeTxn;
  similar: SimilarTxn[];
}

export interface CategorizeSplitLine {
  categoryId: string;
  amountMilli: Milli;
}

export interface CategorizeResult {
  categoryId: string | null;
  confidence: number;
  payeeName: string;
  isTransfer: boolean;
  split: CategorizeSplitLine[] | null;
  needsWebLookup: boolean;
  explanation: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Cost of this call (batch-discounted when parsed from a batch result). */
  costMicroUsd: bigint;
  /** Notes about output repairs (unknown category dropped, split discarded, ...). */
  warnings: string[];
}

export type CategorizeFailure = { ok: false; reason: "refusal" | "max_tokens" | "invalid_output" | "no_output"; detail?: string };
export type CategorizeOutcome = ({ ok: true } & CategorizeResult) | CategorizeFailure;

/** Raw model output, validated with Zod (§9.3 schema). */
export const CategorizeOutputSchema = z.object({
  category_id: z.string().nullable(),
  confidence: z.number(),
  payee_name: z.string(),
  is_transfer: z.boolean(),
  split: z.array(z.object({ category_id: z.string(), amount_milli: z.number().int() })).nullable(),
  needs_web_lookup: z.boolean(),
  explanation: z.string(),
});
export type CategorizeOutput = z.infer<typeof CategorizeOutputSchema>;

/** Categories the model may choose: no card-payment or uncategorized system categories. */
export function selectableCategories(catalog: CatalogCategory[]): CatalogCategory[] {
  return catalog.filter((c) => c.kind !== "cc_payment" && c.kind !== "uncategorized");
}

/** JSON schema for `output_config.format`; category IDs are an enum so the model can't invent one. */
export function categorizeJsonSchema(catalog: CatalogCategory[]): Record<string, unknown> {
  const ids = selectableCategories(catalog).map((c) => c.id);
  const idSchema = ids.length > 0 ? { type: "string", enum: ids } : { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["category_id", "confidence", "payee_name", "is_transfer", "split", "needs_web_lookup", "explanation"],
    properties: {
      category_id: { anyOf: [idSchema, { type: "null" }] },
      confidence: { type: "number", description: "0.0 to 1.0" },
      payee_name: { type: "string", description: "Clean merchant name, e.g. \"Lowe's\"" },
      is_transfer: { type: "boolean" },
      split: {
        anyOf: [
          {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["category_id", "amount_milli"],
              properties: { category_id: idSchema, amount_milli: { type: "integer" } },
            },
          },
          { type: "null" },
        ],
      },
      needs_web_lookup: { type: "boolean" },
      explanation: { type: "string", description: "20 words or fewer" },
    },
  };
}

export const CATEGORIZE_INSTRUCTIONS = `You categorize bank and credit-card transactions for a household that budgets YNAB-style: every dollar is assigned to a category, and each transaction must land in exactly one category from the catalog below, or be split across several.

How to decide:
- Use the normalized payee, the raw bank description, the amount and sign, the account, the date and weekday, the merchant profile (if one is given), the household facts, and the similar past transactions with their final categories. Past decisions by this household are the strongest evidence: if the same payee was categorized consistently before, follow it unless the amount or context clearly differs.
- Amounts are given in dollars and as integer milliunits ($1.00 = 1000). Negative means money left the account (outflow); positive means money came in (inflow).
- Inflows such as paychecks, interest and refunds from employers usually go to "Inflow: Ready to Assign" if it is in the catalog. A refund from a merchant usually goes back to the category the purchase used.
- Card payments and moves between the household's own accounts are transfers, not spending. Set is_transfer=true and category_id=null for those.
- Only propose a split when the transaction obviously spans several categories and the household facts or history support specific amounts. Split amounts are integer milliunits with the same sign as the transaction and must add up exactly to the transaction amount. Otherwise split=null.
- payee_name is the clean, human merchant name as the household would write it (title case, no store numbers, no city, no card or reference numbers), e.g. "Lowe's", "Whole Foods", "Kessler's Mini Mart".
- Never invent a category. category_id must be one of the IDs listed in the catalog, or null when nothing fits.

Confidence calibration (this drives automatic approval, so be honest):
- 0.95 or higher only when the payee and history make the category essentially certain.
- 0.75 to 0.94 when the category is likely but a reasonable person could choose another.
- Below 0.75 when you are guessing. When you do not recognize the merchant at all and there is no merchant profile and no useful history, set needs_web_lookup=true and keep confidence low.
- Generic merchants that sell many kinds of things (Amazon, Walmart, Target, Costco) deserve lower confidence unless history or amount bands make the category clear.

Privacy rules: you only see the fields listed here. Digit runs in descriptions are masked as "••••". Never ask for or infer account numbers, balances or personal details.

explanation: one short reason, 20 words or fewer, plain text.

Respond only with the JSON object described by the output schema.`;

function catalogText(catalog: CatalogCategory[], memory: string[]): string {
  const lines: string[] = ["## Category catalog", "Format: id | group > category | note | target | example payees"];
  for (const c of selectableCategories(catalog)) {
    const parts = [c.id, `${c.group} > ${c.name}`, c.note?.trim() || "-", c.target?.trim() || "-", (c.examplePayees ?? []).slice(0, 5).join(", ") || "-"];
    lines.push(`- ${parts.join(" | ")}`);
  }
  lines.push("", "## Household facts");
  if (memory.length === 0) lines.push("- (none recorded)");
  for (const m of memory) lines.push(`- ${m.trim()}`);
  return lines.join("\n");
}

function dollars(m: Milli): string {
  return `${formatMilli(m)} (${m < 0n ? "outflow" : "inflow"}, amount_milli=${m.toString()})`;
}

export function transactionPrompt(input: CategorizeInput): string {
  const t = input.transaction;
  const lines: string[] = [
    "Categorize this transaction.",
    "",
    `raw_description: ${redactDigits(t.rawDescription)}`,
    `normalized_payee: ${redactDigits(t.normalizedPayee)}`,
    `amount: ${dollars(t.amountMilli)}`,
    `account: ${redactDigits(t.accountLabel)}${t.accountKind ? ` (${t.accountKind})` : ""}`,
    `date: ${t.date} (${WEEKDAYS[weekday(t.date)]})`,
  ];
  if (t.merchant && t.merchant.found !== false) {
    lines.push(
      `merchant_profile: type=${t.merchant.type}; description=${t.merchant.description}; location=${t.merchant.location ?? "-"}; website=${t.merchant.website ?? "-"}; confidence=${t.merchant.confidence}`,
    );
  } else {
    lines.push("merchant_profile: none");
  }
  const similar = input.similar.slice(0, MAX_SIMILAR);
  lines.push("", `## Similar past transactions (${similar.length})`);
  if (similar.length === 0) lines.push("- none");
  for (const s of similar) {
    const cat = s.isTransfer ? "TRANSFER" : s.categoryId ? `${s.categoryName ?? "?"} [${s.categoryId}]` : "uncategorized";
    lines.push(`- ${s.date} | ${redactDigits(s.payee)} | ${formatMilli(s.amountMilli)} | ${cat}`);
  }
  return lines.join("\n");
}

export interface CategorizeRequestOptions {
  model: string;
  maxTokens?: number;
}

/** Build the Messages API params (also used verbatim inside Message Batches requests). */
export function buildCategorizeParams(input: CategorizeInput, opts: CategorizeRequestOptions): BetaCreateParams {
  const system: BetaTextBlockParam[] = [
    { type: "text", text: CATEGORIZE_INSTRUCTIONS },
    { type: "text", text: catalogText(input.catalog, input.householdMemory), cache_control: { type: "ephemeral" } },
  ];
  return {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1024,
    system,
    messages: [{ role: "user", content: transactionPrompt(input) }],
    output_config: { effort: "low", format: { type: "json_schema", schema: categorizeJsonSchema(input.catalog) } },
  };
}

function truncateWords(s: string, n: number): string {
  const w = s.trim().split(/\s+/).filter(Boolean);
  return w.length <= n ? w.join(" ") : `${w.slice(0, n).join(" ")}…`;
}

/** Validate and repair a model response into a CategorizeOutcome. */
export function parseCategorizeMessage(
  msg: Pick<BetaMessage, "content" | "stop_reason" | "model" | "usage">,
  input: CategorizeInput,
  opts: { batch?: boolean; prices?: PriceTable } = {},
): CategorizeOutcome {
  if (msg.stop_reason === "refusal") return { ok: false, reason: "refusal" };
  if (msg.stop_reason === "max_tokens") return { ok: false, reason: "max_tokens" };
  const text = textOf(msg).trim();
  if (!text) return { ok: false, reason: "no_output" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: "invalid_output", detail: `JSON parse: ${(e as Error).message}` };
  }
  const parsed = CategorizeOutputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid_output", detail: parsed.error.message };
  const o = parsed.data;
  const warnings: string[] = [];
  const valid = new Set(selectableCategories(input.catalog).map((c) => c.id));
  let categoryId = o.category_id;
  let confidence = Math.min(1, Math.max(0, Number.isFinite(o.confidence) ? o.confidence : 0));
  if (categoryId !== null && !valid.has(categoryId)) {
    warnings.push(`unknown category_id ${categoryId} dropped`);
    categoryId = null;
    confidence = 0;
  }
  let split: CategorizeSplitLine[] | null = null;
  if (o.split && o.split.length > 0) {
    const lines = o.split.map((l) => ({ categoryId: l.category_id, amountMilli: BigInt(l.amount_milli) }));
    const amount = input.transaction.amountMilli;
    const sameSign = lines.every((l) => (amount < 0n ? l.amountMilli <= 0n : l.amountMilli >= 0n));
    if (lines.length < 2) warnings.push("split with fewer than 2 lines discarded");
    else if (!lines.every((l) => valid.has(l.categoryId))) warnings.push("split with unknown category discarded");
    else if (sumMilli(lines.map((l) => l.amountMilli)) !== amount || !sameSign) warnings.push("split does not add up; discarded");
    else split = lines;
  }
  if (o.is_transfer && categoryId !== null) {
    // transfers carry no category (§9.1 step 1)
    categoryId = null;
  }
  return {
    ok: true,
    categoryId,
    confidence,
    payeeName: o.payee_name.trim().slice(0, 80) || input.transaction.normalizedPayee,
    isTransfer: o.is_transfer,
    split,
    needsWebLookup: o.needs_web_lookup,
    explanation: truncateWords(o.explanation, 20),
    model: msg.model,
    inputTokens: msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
    costMicroUsd: computeCost(msg.model, msg.usage, { batch: opts.batch ?? false, ...(opts.prices ? { prices: opts.prices } : {}) }).costMicroUsd,
    warnings,
  };
}

/** Real-time categorization call (gated by the monthly cap, usage recorded as `categorize`). */
export async function categorizeWithAi(
  ai: AiClient,
  input: CategorizeInput,
  meta: { transactionId?: string; signal?: AbortSignal } = {},
): Promise<CategorizeOutcome> {
  const params = buildCategorizeParams(input, { model: ai.models.categorize });
  const msg = await ai.create("categorize", params, meta);
  return parseCategorizeMessage(msg, input, { prices: ai.prices });
}

