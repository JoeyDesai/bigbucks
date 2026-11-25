import { describe, expect, it } from "vitest";
import {
  AiClient,
  buildCategorizeParams,
  categorizeWithAi,
  categorizeJsonSchema,
  CATEGORIZE_INSTRUCTIONS,
  InMemoryUsageSink,
  lookupMerchant,
  parseCategorizeMessage,
  MASK,
  type CategorizeInput,
  type AiEvent,
} from "../src";
import { FakeAnthropic, fakeMessage, jsonReply, serverToolUseBlock, textBlock, toolUseBlock } from "../src/testing";

const now = () => new Date("2026-10-22T12:00:00Z");
const CATS = [
  { id: "c-groc", group: "Everyday", name: "Groceries", examplePayees: ["Whole Foods", "Kroger"], target: "$900/mo" },
  { id: "c-house", group: "Home", name: "House Projects", examplePayees: ["Lowe's"] },
  { id: "c-dining", group: "Everyday", name: "Dining Out", note: "restaurants, takeout" },
  { id: "c-rta", group: "Inflow", name: "Inflow: Ready to Assign", kind: "internal_rta" as const },
  { id: "c-ccp", group: "Credit Card Payments", name: "Fabrikam", kind: "cc_payment" as const },
];

const input = (over: Partial<CategorizeInput["transaction"]> = {}): CategorizeInput => ({
  catalog: CATS,
  householdMemory: ["Costco runs are mostly groceries"],
  transaction: {
    rawDescription: "PURCHASE AUTHORIZED ON 10/14 LOWE'S #1234 FAIRVIEW VA S586287012345678 CARD 9876",
    normalizedPayee: "Lowe's",
    amountMilli: -48_170n,
    accountLabel: "Contoso card",
    accountKind: "credit_card",
    date: "2026-10-14",
    ...over,
  },
  similar: Array.from({ length: 20 }, (_, i) => ({
    payee: "Lowe's",
    amountMilli: -10_000n * BigInt(i + 1),
    date: "2026-09-01",
    categoryId: "c-house",
    categoryName: "House Projects",
  })),
});

const good = {
  category_id: "c-house",
  confidence: 0.93,
  payee_name: "Lowe's",
  is_transfer: false,
  split: null,
  needs_web_lookup: false,
  explanation: "Hardware store; history says House Projects",
};

describe("buildCategorizeParams", () => {
  const p = buildCategorizeParams(input(), { model: "claude-haiku-5-5" });

  it("uses Haiku with structured output whose category enum excludes system categories", () => {
    expect(p.model).toBe("claude-haiku-5-5");
    const fmt = p.output_config?.format;
    expect(fmt?.type).toBe("json_schema");
    const schema = categorizeJsonSchema(CATS) as { properties: { category_id: { anyOf: { enum?: string[] }[] } } };
    expect(schema.properties.category_id.anyOf[0]!.enum).toEqual(["c-groc", "c-house", "c-dining", "c-rta"]);
  });

  it("caches the system prompt + catalog (≥512 tokens) with cache_control on the last system block", () => {
    const sys = p.system as { text: string; cache_control?: unknown }[];
    expect(sys).toHaveLength(2);
    expect(sys[0]!.cache_control).toBeUndefined();
    expect(sys[1]!.cache_control).toEqual({ type: "ephemeral" });
    // ~4 chars/token: comfortably above the 512-token cache minimum
    expect((sys[0]!.text + sys[1]!.text).length).toBeGreaterThan(2600);
    expect(sys[1]!.text).toContain("c-house | Home > House Projects");
    expect(sys[1]!.text).toContain("Costco runs are mostly groceries");
    expect(sys[1]!.text).not.toContain("c-ccp");
    expect(CATEGORIZE_INSTRUCTIONS).toContain("Never invent a category");
  });

  it("sends only redacted transaction fields and at most 15 similar transactions", () => {
    const user = p.messages[0]!.content as string;
    expect(user).not.toMatch(/\d{4,}(?!\d*\b)/); // no raw 4+ digit runs besides amount_milli/date
    expect(user).toContain(`LOWE'S #${MASK}`);
    expect(user).toContain(`CARD ${MASK}`);
    expect(user).toContain("amount: -$48.17 (outflow, amount_milli=-48170)");
    expect(user).toContain("date: 2026-10-14 (Wednesday)");
    expect((user.match(/\| House Projects \[c-house\]/g) ?? []).length).toBe(15);
  });
});

describe("parseCategorizeMessage", () => {
  const msg = (o: unknown, stop: "end_turn" | "refusal" | "max_tokens" = "end_turn") => fakeMessage({ content: [textBlock(JSON.stringify(o))], stop_reason: stop });

  it("parses a valid response", () => {
    const r = parseCategorizeMessage(msg(good), input());
    expect(r).toMatchObject({ ok: true, categoryId: "c-house", confidence: 0.93, payeeName: "Lowe's", split: null });
  });

  it("drops unknown categories and clamps confidence", () => {
    const r = parseCategorizeMessage(msg({ ...good, category_id: "c-ccp", confidence: 3 }), input());
    expect(r.ok && r.categoryId).toBeNull();
    expect(r.ok && r.confidence).toBe(0);
    expect(r.ok && r.warnings[0]).toMatch(/unknown category_id/);
  });

  it("keeps an exact split and discards one that does not add up", () => {
    const okSplit = parseCategorizeMessage(
      msg({ ...good, split: [{ category_id: "c-house", amount_milli: -30_000 }, { category_id: "c-groc", amount_milli: -18_170 }] }),
      input(),
    );
    expect(okSplit.ok && okSplit.split).toEqual([
      { categoryId: "c-house", amountMilli: -30_000n },
      { categoryId: "c-groc", amountMilli: -18_170n },
    ]);
    const bad = parseCategorizeMessage(msg({ ...good, split: [{ category_id: "c-house", amount_milli: -30_000 }, { category_id: "c-groc", amount_milli: -1 }] }), input());
    expect(bad.ok && bad.split).toBeNull();
  });

  it("truncates explanations to 20 words and nulls the category for transfers", () => {
    const r = parseCategorizeMessage(msg({ ...good, is_transfer: true, explanation: Array(30).fill("w").join(" ") }), input());
    expect(r.ok && r.categoryId).toBeNull();
    expect(r.ok && r.explanation.split(" ")).toHaveLength(20);
  });

  it("reports refusals, truncation and invalid JSON", () => {
    expect(parseCategorizeMessage(msg(good, "refusal"), input())).toEqual({ ok: false, reason: "refusal" });
    expect(parseCategorizeMessage(msg(good, "max_tokens"), input())).toEqual({ ok: false, reason: "max_tokens" });
    expect(parseCategorizeMessage(fakeMessage({ content: [textBlock("not json")] }), input())).toMatchObject({ ok: false, reason: "invalid_output" });
    expect(parseCategorizeMessage(msg({ category_id: "c-house" }), input())).toMatchObject({ ok: false, reason: "invalid_output" });
  });
});

describe("categorizeWithAi", () => {
  it("calls the categorize model and records usage as `categorize`", async () => {
    const fake = new FakeAnthropic([jsonReply(good, { input_tokens: 1500, output_tokens: 60 })]);
    const usage = new InMemoryUsageSink();
    const ai = new AiClient({ anthropic: fake, usage, now });
    const r = await categorizeWithAi(ai, input(), { transactionId: "t1" });
    expect(r.ok).toBe(true);
    expect(fake.calls[0]!.params.model).toBe("claude-haiku-5-5");
    expect(fake.calls[0]!.params.fallbacks).toBeUndefined(); // no server-side fallback on Haiku
    expect(usage.records[0]).toMatchObject({ purpose: "categorize", transactionId: "t1", inputTokens: 1500 });
  });
});

describe("lookupMerchant", () => {
  const report = { identified: true, name: "Kessler's Mini Mart", type: "convenience store", website: null, location: "Fairview, VA", description: "Gas station and deli", confidence: 0.85 };

  it("uses Sonnet + web_search (max_uses 2) and returns the reported profile", async () => {
    const fake = new FakeAnthropic([
      fakeMessage({
        content: [serverToolUseBlock("web_search", { query: "Kessler's Mini Mart Fairview VA" }), textBlock("Found it."), toolUseBlock("report_merchant", report)],
        usage: { web_search_requests: 1 },
      }),
    ]);
    const usage = new InMemoryUsageSink();
    const ai = new AiClient({ anthropic: fake, usage, now });
    const r = await lookupMerchant(ai, { merchant: "KESSLER S MINFAIRVIEW 0042", city: "Fairview", state: "VA" });
    expect(r.status).toBe("found");
    if (r.status !== "found") throw new Error();
    expect(r.profile).toMatchObject({ type: "convenience store", location: "Fairview, VA", confidence: 0.85, found: true, looked_up_at: "2026-10-22T12:00:00.000Z" });
    const p = fake.calls[0]!.params;
    expect(p.model).toBe("claude-sonnet-5-5");
    expect(p.tools).toContainEqual({ type: "web_search_20260209", name: "web_search", max_uses: 2 });
    expect(p.fallbacks).toBe("default");
    expect(JSON.stringify(p.messages)).not.toContain("0042");
    expect(usage.records[0]).toMatchObject({ purpose: "merchant_lookup", webSearches: 1 });
    expect(usage.records[0]!.costMicroUsd).toBeGreaterThanOrEqual(10_000n);
  });

  it("continues after pause_turn", async () => {
    const fake = new FakeAnthropic([
      fakeMessage({ content: [serverToolUseBlock("web_search", { query: "Kessler's Mini Mart" })], stop_reason: "pause_turn" }),
      fakeMessage({ content: [toolUseBlock("report_merchant", report)] }),
    ]);
    const ai = new AiClient({ anthropic: fake, usage: new InMemoryUsageSink(), now });
    const r = await lookupMerchant(ai, { merchant: "KESSLER S MIN" });
    expect(r.status).toBe("found");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.params.messages).toHaveLength(2);
  });

  it("discards the result and raises an event when a search query leaks data", async () => {
    const fake = new FakeAnthropic([
      fakeMessage({ content: [serverToolUseBlock("web_search", { query: "Kessler's Mini Mart $43.17 Sam" }), toolUseBlock("report_merchant", report)] }),
    ]);
    const events: AiEvent[] = [];
    const ai = new AiClient({ anthropic: fake, usage: new InMemoryUsageSink(), now, events: { emit: (e) => void events.push(e) } });
    const r = await lookupMerchant(ai, { merchant: "KESSLER S MIN" }, { householdNames: ["Sam"] });
    expect(r.status).toBe("rejected");
    expect(events[0]).toMatchObject({ type: "web_query_rejected" });
  });

  it("returns not_found (still cacheable) when the business is unidentified", async () => {
    const fake = new FakeAnthropic([fakeMessage({ content: [toolUseBlock("report_merchant", { ...report, identified: false, confidence: 0.1 })] })]);
    const ai = new AiClient({ anthropic: fake, usage: new InMemoryUsageSink(), now });
    const r = await lookupMerchant(ai, { merchant: "XQZ 77" });
    expect(r.status).toBe("not_found");
  });

  it("is unavailable at the cap", async () => {
    const ai = new AiClient({ anthropic: new FakeAnthropic([]), usage: new InMemoryUsageSink({ "2026-10-01": 9_000_000n }), now });
    expect(await lookupMerchant(ai, { merchant: "X" })).toEqual({ status: "unavailable" });
  });
});
