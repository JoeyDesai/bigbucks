import { describe, expect, it } from "vitest";
import { AiClient, InMemoryUsageSink, type MerchantProfile } from "@homebase/ai";
import { FakeAnthropic, fakeMessage, jsonReply, toolUseBlock } from "@homebase/ai/testing";
import { categorizeTransaction, createAiCategorizer, InMemoryCategorizerRepo, loadPipelineContext, type StoredTxn, type TxnInput } from "../src";
import { ACCOUNTS, CATS, stubAi } from "./fixtures";

const now = () => new Date("2026-10-22T12:00:00Z");
const tx = (o: Partial<TxnInput> & Pick<TxnInput, "rawDescription" | "amountMilli">): TxnInput => ({ id: "t-new", accountId: "a-card", date: "2026-10-20", ...o });
let k = 0;
const past = (raw: string, categoryId: string | null, amountMilli: bigint, date = "2026-09-01", extra: Partial<StoredTxn> = {}) =>
  InMemoryCategorizerRepo.txn({ id: `p${++k}`, accountId: "a-card", date, amountMilli, rawDescription: raw, categoryId, approved: true, ...extra });

function repoWith(extra: ConstructorParameters<typeof InMemoryCategorizerRepo>[0] = {}) {
  return new InMemoryCategorizerRepo({ categories: CATS, accounts: ACCOUNTS, memory: ["Costco runs are mostly groceries"], ...extra });
}

describe("pipeline: deterministic steps", () => {
  it("step 1: card payment is a transfer and is approved", async () => {
    const repo = repoWith({ pending: [InMemoryCategorizerRepo.txn({ id: "pay-in", accountId: "a-fab", date: "2026-10-21", amountMilli: 512_340n, rawDescription: "INTERNET PAYMENT - THANK YOU", categoryId: null })] });
    const ai = stubAi({});
    const r = await categorizeTransaction(tx({ accountId: "a-chk", rawDescription: "FABRIKAM E-PAYMENT 1234", amountMilli: -512_340n }), { repo, ai, now });
    expect(r.transfer?.kind).toBe("card_payment");
    expect(r.catz).toMatchObject({ method: "transfer", confidence: 0.99 });
    expect(r.categoryId).toBeNull();
    expect(r.approved).toBe(true);
    expect(ai.calls).toHaveLength(0);
    expect(repo.events).toHaveLength(1);
  });

  it("step 1: Mercury → checking goes to Ready to Assign and needs review the first 3 times", async () => {
    const repo = repoWith({ pending: [InMemoryCategorizerRepo.txn({ id: "m", accountId: "a-merc", date: "2026-10-19", amountMilli: -3_000_000n, rawDescription: "Send Money transaction initiated on Mercury", categoryId: null })] });
    const r = await categorizeTransaction(tx({ accountId: "a-chk", rawDescription: "MERCURY ACH NORTHWIND STUDIO", amountMilli: 3_000_000n }), { repo, now });
    expect(r.transfer?.kind).toBe("business_to_household");
    expect(r.categoryId).toBe("c-rta");
    expect(r.approved).toBe(false);
    expect(r.reviewReasons.join(" ")).toMatch(/first 3/);
  });

  it("step 2: user rules decide before history, and record a hit", async () => {
    const repo = repoWith({
      transactions: Array.from({ length: 5 }, () => past("LOWE'S #1234 FAIRVIEW VA", "c-misc", -20_000n)),
      rules: [{ id: "r-lowes", priority: 1, enabled: true, source: "user", conditions: [{ field: "payee", op: "equals", value: "Lowe's" }], actions: { setCategoryId: "c-house" } }],
    });
    const r = await categorizeTransaction(tx({ rawDescription: "PURCHASE AUTHORIZED ON 10/20 LOWE'S #1234 FAIRVIEW VA", amountMilli: -48_170n }), { repo, now });
    expect(r).toMatchObject({ categoryId: "c-house", approved: true, catz: { method: "rule", rule_id: "r-lowes", confidence: 1 } });
    expect(repo.ruleHits.map((h) => h.ruleId)).toEqual(["r-lowes"]);
  });

  it("step 3: history with amount bands (Costco gas vs groceries)", async () => {
    const hist = [
      ...[42, 55, 38, 51].map((d) => past("COSTCO GAS #0123 FAIRVIEW VA", "c-gas", -BigInt(d) * 1000n)),
      ...[182, 96, 240, 65, 133].map((d) => past("COSTCO WHSE #0123 FAIRVIEW VA", "c-groc", -BigInt(d) * 1000n)),
    ];
    const repo = repoWith({ transactions: hist });
    const ai = stubAi({});
    const gas = await categorizeTransaction(tx({ rawDescription: "COSTCO GAS #0123 FAIRVIEW VA", amountMilli: -47_000n }), { repo, ai, now });
    expect(gas).toMatchObject({ categoryId: "c-gas", catz: { method: "history" } });
    const groc = await categorizeTransaction(tx({ id: "t2", rawDescription: "COSTCO WHSE #0123 FAIRVIEW VA", amountMilli: -150_000n }), { repo, ai, now });
    expect(groc.categoryId).toBe("c-groc");
    expect(ai.calls).toHaveLength(0);
  });

  it("history never reads transactions on or after the transaction date", async () => {
    const repo = repoWith({ transactions: Array.from({ length: 5 }, () => past("KROGER #12", "c-groc", -30_000n, "2026-10-25")) });
    const r = await categorizeTransaction(tx({ rawDescription: "KROGER #12", amountMilli: -30_000n }), { repo, now });
    expect(r.categoryId).toBeNull();
    expect(r.catz.confidence).toBe(0);
  });
});

describe("pipeline: AI steps", () => {
  it("step 4: sends catalog, memory, redacted transaction and ≤15 similar txns; applies a confident answer", async () => {
    const repo = repoWith({ transactions: Array.from({ length: 20 }, (_, i) => past(`BLUE RIDGE COFFEE ${i}`, "c-dining", -6_000n)) });
    const ai = stubAi({ categorize: () => ({ categoryId: "c-dining", confidence: 0.96 }) });
    const r = await categorizeTransaction(tx({ rawDescription: "SQ *BLUE RIDGE CAFE 4455 Fairview VA", amountMilli: -7_250n }), { repo, ai, now });
    expect(r).toMatchObject({ categoryId: "c-dining", approved: true, catz: { method: "ai", model: "claude-haiku-5-5" } });
    const input = ai.calls[0]!.input;
    expect(input.catalog.map((c) => c.id)).toContain("c-dining");
    expect(input.householdMemory).toEqual(["Costco runs are mostly groceries"]);
    expect(input.transaction.accountLabel).toBe("Contoso card");
    expect(input.similar.length).toBeLessThanOrEqual(15);
    expect(input.similar.length).toBeGreaterThan(0);
    expect(r.ai).toMatchObject({ calls: 1, costMicroUsd: 125n });
    expect(repo.events[0]).toMatchObject({ method: "ai", finalCategoryId: "c-dining", accepted: true, costMicroUsd: 125n });
  });

  it("step 5: unknown merchant + low confidence → one web lookup, cached on the payee, then re-run with the profile (ai_web)", async () => {
    const repo = repoWith();
    const profile: MerchantProfile = { website: null, type: "restaurant", location: "Fairview, VA", description: "Kessler's Mini Mart: deli and convenience store", confidence: 0.85, looked_up_at: now().toISOString(), found: true };
    const ai = stubAi({
      categorize: (i) => (i.transaction.merchant ? { categoryId: "c-dining", confidence: 0.9 } : { categoryId: null, confidence: 0.3, needsWebLookup: true }),
      lookup: () => ({ status: "found", profile, queries: ["Kessler's Mini Mart Fairview"] }),
    });
    const r = await categorizeTransaction(tx({ rawDescription: "KESSLER S MINFAIRVIEW", amountMilli: -18_400n }), { repo, ai, now });
    expect(ai.lookups).toHaveLength(1);
    expect(r).toMatchObject({ categoryId: "c-dining", approved: false, catz: { method: "ai_web", confidence: 0.9 } });
    expect(r.ai).toMatchObject({ calls: 2, merchantLookup: "performed" });
    expect((await repo.getPayeeByKey(r.payee.key))?.merchant).toEqual(profile);

    // Second transaction from the same merchant: profile is cached → no new lookup.
    const r2 = await categorizeTransaction(tx({ id: "t-2", rawDescription: "KESSLER S MINFAIRVIEW", amountMilli: -9_000n }), { repo, ai, now });
    expect(ai.lookups).toHaveLength(1);
    expect(r2.ai.merchantLookup).toBe("cached");
    expect(ai.calls.at(-1)!.input.transaction.merchant).toEqual(profile);
  });

  it("caches not-found lookups too, so a merchant is looked up once", async () => {
    const repo = repoWith();
    const ai = stubAi({
      categorize: () => ({ categoryId: null, confidence: 0.2, needsWebLookup: true }),
      lookup: () => ({ status: "not_found", profile: { website: null, type: "unknown", location: null, description: "", confidence: 0.1, looked_up_at: "x", found: false }, queries: [] }),
    });
    await categorizeTransaction(tx({ rawDescription: "XQZ TRADING 77", amountMilli: -9_000n }), { repo, ai, now });
    await categorizeTransaction(tx({ id: "t2", rawDescription: "XQZ TRADING 77", amountMilli: -9_000n }), { repo, ai, now });
    expect(ai.lookups).toHaveLength(1);
    expect(ai.calls).toHaveLength(2);
  });

  it("step 6: uncategorized with top-3 suggestions below 0.75", async () => {
    const repo = repoWith({ transactions: [past("TARGET 0042", "c-groc", -50_000n), past("TARGET 0042", "c-house", -20_000n)] });
    const ai = stubAi({ categorize: () => ({ categoryId: "c-misc", confidence: 0.6 }) });
    const r = await categorizeTransaction(tx({ rawDescription: "TARGET 0042 MILTON VA", amountMilli: -33_000n }), { repo, ai, now });
    expect(r.categoryId).toBeNull();
    expect(r.approved).toBe(false);
    expect(r.suggestions[0]!.categoryId).toBe("c-misc");
    expect(r.suggestions.map((s) => s.categoryId).sort()).toEqual(["c-groc", "c-house", "c-misc"]);
    expect(r.catz.suggestions).toHaveLength(3);
    expect(r.reviewReasons.join(" ")).toMatch(/suggestion only/);
  });

  it("categorizes but leaves unapproved between 0.75 and 0.95, and AI > $150 never auto-approves", async () => {
    const repo = repoWith();
    const ai = stubAi({ categorize: (i) => ({ categoryId: "c-house", confidence: i.transaction.amountMilli < -150_000n ? 0.99 : 0.8 }) });
    const mid = await categorizeTransaction(tx({ rawDescription: "ACE HARDWARE 12 MILTON VA", amountMilli: -30_000n }), { repo, ai, now });
    expect(mid).toMatchObject({ categoryId: "c-house", approved: false });
    const big = await categorizeTransaction(tx({ id: "t2", rawDescription: "ACE HARDWARE 12 MILTON VA", amountMilli: -400_000n }), { repo, ai, now });
    expect(big).toMatchObject({ categoryId: "c-house", approved: false });
  });

  it("at the monthly cap falls back to rules/history only (no AI calls)", async () => {
    const repo = repoWith();
    const ai = stubAi({ available: false });
    const r = await categorizeTransaction(tx({ rawDescription: "NEW PLACE 77", amountMilli: -9_000n }), { repo, ai, now });
    expect(ai.calls).toHaveLength(0);
    expect(r.categoryId).toBeNull();
    expect(r.reviewReasons.join(" ")).toMatch(/monthly cap/);
  });

  it("proposes a payee alias from the AI's clean name (auto at ≥ 0.9)", async () => {
    const repo = repoWith();
    const ai = stubAi({ categorize: () => ({ categoryId: "c-dining", confidence: 0.92, payeeName: "Kessler's Mini Mart" }) });
    const r = await categorizeTransaction(tx({ rawDescription: "KESSLER S MINFAIRVIEW #0042", amountMilli: -9_000n }), { repo, ai, now });
    expect(r.payee).toMatchObject({ name: "Kessler's Mini Mart", key: "kesslersminimart", aliasProposal: { pattern: "KESSLER S MINFAIRVIEW", match: "prefix", autoCreate: true } });
  });

  it("keeps the AI's nicer display name when it normalizes to the same key (no alias)", async () => {
    const repo = repoWith();
    const ai = stubAi({ categorize: () => ({ categoryId: "c-dining", confidence: 0.92, payeeName: "Kessler's Deli" }) });
    const r = await categorizeTransaction(tx({ rawDescription: "KESSLERS DELI 4411", amountMilli: -9_000n }), { repo, ai, now });
    expect(r.payee).toMatchObject({ name: "Kessler's Deli", key: "kesslersdeli", originalKey: "kesslersdeli", aliasProposal: null });
  });

  it("does not apply an AI 'transfer' guess without a matching pair", async () => {
    const repo = repoWith();
    const ai = stubAi({ categorize: () => ({ categoryId: null, confidence: 0.9, isTransfer: true }) });
    const r = await categorizeTransaction(tx({ rawDescription: "ZELLE TO SOMEONE", amountMilli: -9_000n }), { repo, ai, now });
    expect(r.transfer).toBeNull();
    expect(r.categoryId).toBeNull();
    expect(r.reviewReasons.join(" ")).toMatch(/transfer/);
  });

  it("works end-to-end with the real AiClient and a fake Anthropic client", async () => {
    const repo = repoWith();
    const fake = new FakeAnthropic([
      jsonReply({ category_id: null, confidence: 0.3, payee_name: "Kessler's Mini Mart", is_transfer: false, split: null, needs_web_lookup: true, explanation: "Unknown merchant" }),
      fakeMessage({
        content: [toolUseBlock("report_merchant", { identified: true, name: "Kessler's Mini Mart", type: "convenience store and deli", website: null, location: "Fairview, VA", description: "Deli", confidence: 0.8 })],
        usage: { web_search_requests: 1 },
      }),
      jsonReply({ category_id: "c-dining", confidence: 0.88, payee_name: "Kessler's Mini Mart", is_transfer: false, split: null, needs_web_lookup: false, explanation: "Deli lunch" }),
    ]);
    const usage = new InMemoryUsageSink();
    const client = new AiClient({ anthropic: fake, usage, now });
    const ctx = await loadPipelineContext(repo);
    const r = await categorizeTransaction(tx({ rawDescription: "KESSLER S MINFAIRVIEW", amountMilli: -18_400n }), { repo, ai: createAiCategorizer(client, { householdNames: ["Alex", "Sam"] }), now }, ctx);
    expect(r).toMatchObject({ categoryId: "c-dining", catz: { method: "ai_web" } });
    expect(fake.calls.map((c) => c.params.model)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(usage.records.map((u) => u.purpose)).toEqual(["categorize", "merchant_lookup", "categorize"]);
  });
});
