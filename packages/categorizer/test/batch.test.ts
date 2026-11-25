import { describe, expect, it } from "vitest";
import { AiClient, InMemoryUsageSink } from "@homebase/ai";
import { FakeAnthropic, jsonReply, type FakeResponder } from "@homebase/ai/testing";
import { batchCustomId, batchStatus, buildBatchRequests, collectBatchResults, InMemoryCategorizerRepo, loadPipelineContext, prepareTransaction, submitBacklogBatch, type TxnInput } from "../src";
import { ACCOUNTS, CATS } from "./fixtures";

const now = () => new Date("2026-10-22T03:00:00Z");
const tx = (id: string, raw: string, amountMilli: bigint): TxnInput => ({ id, accountId: "a-card", date: "2026-10-20", amountMilli, rawDescription: raw });

function repo() {
  return new InMemoryCategorizerRepo({
    categories: CATS,
    accounts: ACCOUNTS,
    transactions: Array.from({ length: 4 }, (_, i) => InMemoryCategorizerRepo.txn({ id: `k${i}`, accountId: "a-card", date: "2026-09-0" + (i + 1), amountMilli: -30_000n, rawDescription: "KROGER #12", categoryId: "c-groc" })),
  });
}

const reply = (categoryId: string | null, confidence: number) =>
  jsonReply({ category_id: categoryId, confidence, payee_name: "X", is_transfer: false, split: null, needs_web_lookup: false, explanation: "batch" }, { input_tokens: 2000, output_tokens: 100 });

describe("Message Batches backlog path", () => {
  it("decides history matches synchronously and batches the rest with valid custom_ids", async () => {
    const r = repo();
    const ctx = await loadPipelineContext(r);
    const txns = [tx("0192f3a0-aaaa-7abc-8def-000000000001", "KROGER #12 MILTON VA", -31_000n), tx("0192f3a0-aaaa-7abc-8def-000000000002", "MYSTERY SHOP 7", -9_000n)];
    const prepared = await Promise.all(txns.map((t) => prepareTransaction(t, ctx, { repo: r, now })));
    const reqs = buildBatchRequests(prepared, "claude-haiku-5-5");
    expect(reqs.map((q) => q.custom_id)).toEqual(["0192f3a0-aaaa-7abc-8def-000000000002"]);
    expect(reqs[0]!.params.model).toBe("claude-haiku-5-5");
    expect(reqs[0]!.params.output_config?.format?.type).toBe("json_schema");
    expect((reqs[0]!.params as { fallbacks?: unknown }).fallbacks).toBeUndefined();
    expect(() => batchCustomId("bad id!")).toThrow();
  });

  it("submits, polls, and collects results keyed by custom_id (any order) at batch prices", async () => {
    const r = repo();
    const ctx = await loadPipelineContext(r);
    const responder: FakeResponder = (params) => {
      const u = JSON.stringify(params.messages);
      if (u.includes("BROKEN")) return new Error("boom");
      return u.includes("ACE HARDWARE") ? reply("c-house", 0.97) : reply("c-dining", 0.6);
    };
    const fake = new FakeAnthropic(responder);
    fake.pollsUntilEnded = 2;
    const usage = new InMemoryUsageSink();
    const ai = new AiClient({ anthropic: fake, usage, now });
    const txns = [tx("t-kroger", "KROGER #12", -31_000n), tx("t-ace", "ACE HARDWARE 12 MILTON VA", -42_000n), tx("t-cafe", "SOME CAFE", -12_000n), tx("t-broken", "BROKEN THING", -1_000n)];
    const sub = await submitBacklogBatch(txns, { repo: r, ai, now }, ctx);
    expect(sub.decided.map((d) => d.transactionId)).toEqual(["t-kroger"]);
    expect(sub.queuedIds).toEqual(["t-ace", "t-cafe", "t-broken"]);
    expect(sub.batchId).toBeTruthy();
    expect((await batchStatus(ai, sub.batchId!)).ended).toBe(false);
    expect((await batchStatus(ai, sub.batchId!)).ended).toBe(true);

    const queued = txns.filter((t) => sub.queuedIds.includes(t.id));
    const col = await collectBatchResults(sub.batchId!, queued, { repo: r, ai, now }, ctx);
    const byId = new Map(col.results.map((x) => [x.transactionId, x]));
    expect(byId.get("t-ace")).toMatchObject({ categoryId: "c-house", approved: true, catz: { method: "ai" } });
    expect(byId.get("t-cafe")).toMatchObject({ categoryId: null, approved: false });
    expect(col.failed).toEqual([{ transactionId: "t-broken", reason: "errored" }]);
    // 2000 in + 100 out on Haiku = 200µ + 50µ = 250µ, halved for batch
    expect(usage.records.map((u) => [u.purpose, u.batch, u.costMicroUsd])).toEqual([
      ["batch_categorize", true, 125n],
      ["batch_categorize", true, 125n],
    ]);
    expect(byId.get("t-ace")!.ai.costMicroUsd).toBe(125n);
    expect(r.events.map((e) => e.transactionId).sort()).toEqual(["t-ace", "t-cafe", "t-kroger"]);
  });

  it("does not submit when AI is capped", async () => {
    const r = repo();
    const ctx = await loadPipelineContext(r);
    const ai = new AiClient({ anthropic: new FakeAnthropic([]), usage: new InMemoryUsageSink({ "2026-10-01": 8_000_000n }), now });
    const sub = await submitBacklogBatch([tx("t1", "MYSTERY", -1_000n)], { repo: r, ai, now }, ctx);
    expect(sub.batchId).toBeNull();
  });
});
