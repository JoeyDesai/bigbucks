/**
 * §9.1 step 5: identify an unknown merchant with Sonnet + the web_search server tool (max_uses 2).
 *
 * The result is returned through a strict client tool (`report_merchant`) so it is schema-valid;
 * the caller caches it in payees.merchant so each merchant is looked up once. Only the merchant
 * string and a city ever go into the prompt; the queries the model actually ran are audited with
 * the web-query guard and a violation discards the result.
 */
import { z } from "zod";
import type { AiClient, BetaMessage, BetaMessageParam, BetaToolUnion } from "./client";
import { textOf } from "./client";
import { checkWebSearchQuery, redactDigits, type WebQueryPolicy } from "./redact";
import { extractJsonObject } from "./json";
import type { MerchantProfile } from "./types";

export interface MerchantLookupQuery {
  /** The bank merchant string, e.g. "KESSLER S MINFAIRVIEW". Digits are masked before sending. */
  merchant: string;
  city?: string | null;
  state?: string | null;
}

export type MerchantLookupResult =
  | { status: "found" | "not_found"; profile: MerchantProfile; queries: string[] }
  | { status: "rejected"; reason: string; queries: string[] }
  | { status: "unavailable" }
  | { status: "error"; reason: string; queries: string[] };

const ReportSchema = z.object({
  identified: z.boolean(),
  name: z.string(),
  type: z.string(),
  website: z.string().nullable(),
  location: z.string().nullable(),
  description: z.string(),
  confidence: z.number(),
});

export const REPORT_TOOL_NAME = "report_merchant";

const REPORT_TOOL: BetaToolUnion = {
  name: REPORT_TOOL_NAME,
  description: "Report what business the bank descriptor refers to. Call exactly once, at the end.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["identified", "name", "type", "website", "location", "description", "confidence"],
    properties: {
      identified: { type: "boolean", description: "false if you could not tell what the business is" },
      name: { type: "string", description: "Business name as customers know it" },
      type: { type: "string", description: "Kind of business, e.g. restaurant, hardware store, streaming service" },
      website: { anyOf: [{ type: "string" }, { type: "null" }] },
      location: { anyOf: [{ type: "string" }, { type: "null" }], description: "City, state" },
      description: { type: "string", description: "One sentence, 25 words or fewer" },
      confidence: { type: "number", description: "0.0 to 1.0" },
    },
  },
};

export const MERCHANT_LOOKUP_SYSTEM = `You identify businesses from the merchant strings that appear on US bank and credit-card statements, for a household budgeting app.

Bank descriptors are truncated and squashed, e.g. "KESSLER S MINFAIRVIEW" is likely "Kessler's Mini Mart" in Fairview. Use web search (at most 2 searches) to find out what kind of business it is.

Privacy rules for your searches, which you must follow strictly:
- A search query may contain only the merchant name text and, optionally, the city and state.
- Never include amounts, dates, digits from the descriptor, card or account details, or any personal names.

When you are done, call the report_merchant tool exactly once. If you cannot tell what the business is, call it with identified=false and confidence below 0.3.`;

const MAX_REQUESTS = 4; // allows a few pause_turn continuations

export interface MerchantLookupOptions extends WebQueryPolicy {
  signal?: AbortSignal;
}

export function merchantLookupPrompt(q: MerchantLookupQuery): string {
  const where = [q.city, q.state].filter((x) => x && x.trim()).join(", ");
  return `Merchant descriptor: "${redactDigits(q.merchant).trim()}"${where ? `\nCity hint: ${where}` : ""}`;
}

function searchQueries(msg: BetaMessage): string[] {
  const out: string[] = [];
  for (const b of msg.content) {
    if (b.type === "server_tool_use" && b.name === "web_search") {
      const q = (b.input as { query?: unknown } | null)?.query;
      if (typeof q === "string") out.push(q);
    }
  }
  return out;
}

export async function lookupMerchant(ai: AiClient, q: MerchantLookupQuery, opts: MerchantLookupOptions = {}): Promise<MerchantLookupResult> {
  if (!(await ai.isAvailable("merchant_lookup"))) return { status: "unavailable" };
  const messages: BetaMessageParam[] = [{ role: "user", content: merchantLookupPrompt(q) }];
  const tools: BetaToolUnion[] = [{ type: "web_search_20260209", name: "web_search", max_uses: 2 }, REPORT_TOOL];
  const queries: string[] = [];
  let report: unknown = null;
  let lastText = "";

  for (let i = 0; i < MAX_REQUESTS; i++) {
    const msg = await ai.create(
      "merchant_lookup",
      {
        model: ai.models.merchantLookup,
        max_tokens: 4096,
        system: MERCHANT_LOOKUP_SYSTEM,
        tools,
        messages,
        output_config: { effort: "low" },
      },
      opts.signal ? { signal: opts.signal } : {},
    );
    queries.push(...searchQueries(msg));
    lastText = textOf(msg);
    const call = msg.content.find((b) => b.type === "tool_use" && b.name === REPORT_TOOL_NAME);
    if (call && call.type === "tool_use") {
      report = call.input;
      break;
    }
    if (msg.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: msg.content });
      continue;
    }
    if (msg.stop_reason === "refusal") return { status: "error", reason: "refusal", queries };
    break;
  }

  for (const query of queries) {
    const check = checkWebSearchQuery(query, opts);
    if (!check.ok) {
      await ai.emit({ type: "web_query_rejected", query, reason: check.reason });
      return { status: "rejected", reason: check.reason, queries };
    }
  }

  if (report === null) report = extractJsonObject(lastText);
  const parsed = ReportSchema.safeParse(report);
  if (!parsed.success) return { status: "error", reason: "no usable report", queries };
  const r = parsed.data;
  const confidence = Math.min(1, Math.max(0, r.confidence));
  const found = r.identified && confidence >= 0.3 && r.type.trim() !== "";
  const profile: MerchantProfile = {
    website: r.website?.trim() || null,
    type: r.type.trim() || "unknown",
    location: r.location?.trim() || null,
    description: (r.name.trim() ? `${r.name.trim()}: ` : "") + r.description.trim(),
    confidence,
    looked_up_at: ai.now().toISOString(),
    found,
  };
  return { status: found ? "found" : "not_found", profile, queries };
}
