import { describe, expect, it } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  AiCapExceededError,
  AiClient,
  computeCost,
  capStateFor,
  microUsdToUsdString,
  usdToMicro,
  InMemoryUsageSink,
  resolveModels,
  DEFAULT_MODELS,
  type AiEvent,
  type AnthropicLike,
} from "../src";
import { FakeAnthropic, textReply } from "../src/testing";

describe("price table + cost math", () => {
  it("prices Haiku 5.5 input/output exactly", () => {
    // 50k in @ $0.10/MTok = 5,000µ; 50k out @ $0.50/MTok = 25,000µ
    const c = computeCost("claude-haiku-5-5", { input_tokens: 50_000, output_tokens: 50_000 });
    expect(c.costMicroUsd).toBe(30_000n);
    expect(c.estimated).toBe(false);
  });

  it("prices Sonnet 5.5 with cache reads and writes", () => {
    // 10k input @ $2 = 20,000µ; 2k out @ $10 = 20,000µ; 50k cache read @ $0.20 = 10,000µ; 4k cache write @ $2.50 = 10,000µ
    const c = computeCost("claude-sonnet-5-5", {
      input_tokens: 10_000,
      output_tokens: 2_000,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 4_000,
    });
    expect(c.costMicroUsd).toBe(60_000n);
    expect(c.cacheReadTokens).toBe(50_000);
    expect(c.cacheWriteTokens).toBe(4_000);
  });

  it("charges 1h cache writes at 2x input", () => {
    const c = computeCost("claude-opus-5-5", {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000 },
    });
    expect(c.costMicroUsd).toBe(8_000n); // 1k × $8/MTok
  });

  it("adds $10 per 1k web searches", () => {
    const c = computeCost("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 2 } });
    expect(c.costMicroUsd).toBe(20_000n);
    expect(c.webSearches).toBe(2);
  });

  it("halves token cost for batches", () => {
    const full = computeCost("claude-haiku-5-5", { input_tokens: 2_000, output_tokens: 200 });
    const batch = computeCost("claude-haiku-5-5", { input_tokens: 2_000, output_tokens: 200 }, { batch: true });
    expect(full.costMicroUsd).toBe(300n);
    expect(batch.costMicroUsd).toBe(150n);
  });

  it("uses Haiku long-context pricing above 100K prompt tokens", () => {
    const c = computeCost("claude-haiku-5-5", { input_tokens: 200_000, output_tokens: 0 });
    expect(c.costMicroUsd).toBe(100_000n); // $0.50/MTok
  });

  it("prices fallback iterations at each model's rate", () => {
    const c = computeCost("claude-sonnet-5-5", {
      input_tokens: 0,
      output_tokens: 0,
      iterations: [
        { type: "message", model: "claude-sonnet-5-5", input_tokens: 1_000, output_tokens: 0 },
        { type: "fallback_message", model: "claude-opus-5-5", input_tokens: 1_000, output_tokens: 0 },
      ],
    });
    expect(c.costMicroUsd).toBe(2_000n + 4_000n);
  });

  it("falls back to the most expensive known price for unknown models", () => {
    const c = computeCost("claude-mystery", { input_tokens: 1_000_000, output_tokens: 0 });
    expect(c.estimated).toBe(true);
    expect(c.costMicroUsd).toBe(10_000_000n); // fable-5-1 input $10/MTok
  });

  it("formats and parses micro-USD", () => {
    expect(microUsdToUsdString(1_234_567n)).toBe("1.234567");
    expect(usdToMicro("8")).toBe(8_000_000n);
    expect(usdToMicro("0.5")).toBe(500_000n);
  });
});

describe("models", () => {
  it("defaults per spec §11.1 and accepts overrides", () => {
    expect(DEFAULT_MODELS).toEqual({
      chat: "claude-sonnet-5-5",
      deep: "claude-opus-5-5",
      categorize: "claude-haiku-5-5",
      digest: "claude-haiku-5-5",
      merchantLookup: "claude-sonnet-5-5",
    });
    expect(resolveModels({ chat: "claude-opus-5-5", deep: "  " }).chat).toBe("claude-opus-5-5");
    expect(resolveModels({ deep: "  " }).deep).toBe("claude-opus-5-5");
  });
});

describe("monthly cap", () => {
  const now = () => new Date("2026-10-22T16:00:00Z");

  it("computes cap states at 80% and 100%", () => {
    expect(capStateFor(7_999_999n - 1_600_000n, 8_000_000n)).toBe("ok");
    expect(capStateFor(6_400_000n, 8_000_000n)).toBe("warning");
    expect(capStateFor(8_000_000n, 8_000_000n)).toBe("exceeded");
  });

  it("emits a warning when a call crosses 80%, and cap_reached at 100%", async () => {
    const usage = new InMemoryUsageSink({ "2026-10-01": 6_390_000n });
    const events: AiEvent[] = [];
    const ai = new AiClient({ anthropic: new FakeAnthropic([]), usage, now, events: { emit: (e) => void events.push(e) } });
    await ai.recordUsage("chat", "claude-sonnet-5-5", { input_tokens: 10_000, output_tokens: 0 }); // +$0.02 → 6.41
    expect(events.map((e) => e.type)).toEqual(["cap_warning"]);
    await ai.recordUsage("chat", "claude-sonnet-5-5", { input_tokens: 10_000, output_tokens: 0 });
    expect(events).toHaveLength(1); // only on crossing
    await ai.recordUsage("chat", "claude-opus-5-5", { input_tokens: 0, output_tokens: 100_000 }); // +$2
    expect(events.map((e) => e.type)).toEqual(["cap_warning", "cap_reached"]);
    expect((await ai.capStatus()).state).toBe("exceeded");
  });

  it("disables every AI purpose at 100% and throws for chat", async () => {
    const usage = new InMemoryUsageSink({ "2026-10-01": 8_000_000n });
    const fake = new FakeAnthropic([textReply("hi")]);
    const ai = new AiClient({ anthropic: fake, usage, now });
    expect(await ai.isAvailable("chat")).toBe(false);
    expect(await ai.isAvailable("categorize")).toBe(false);
    await expect(ai.create("chat", { model: "claude-sonnet-5-5", max_tokens: 10, messages: [{ role: "user", content: "x" }] })).rejects.toBeInstanceOf(
      AiCapExceededError,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("counts the new month from zero", async () => {
    const usage = new InMemoryUsageSink({ "2026-09-01": 9_000_000n });
    const ai = new AiClient({ anthropic: new FakeAnthropic([]), usage, now });
    expect(await ai.isAvailable("chat")).toBe(true);
  });

  it("respects a custom cap and the master switch", async () => {
    const usage = new InMemoryUsageSink({ "2026-10-01": 1_000_000n });
    expect(await new AiClient({ anthropic: new FakeAnthropic([]), usage, now, capMicroUsd: 1_000_000n }).isAvailable("digest")).toBe(false);
    expect(await new AiClient({ anthropic: new FakeAnthropic([]), usage, now, enabled: false }).isAvailable("digest")).toBe(false);
  });
});

describe("AiClient.create", () => {
  it("records usage per call with purpose, model and cost", async () => {
    const usage = new InMemoryUsageSink();
    const fake = new FakeAnthropic([textReply("ok", { input_tokens: 1000, output_tokens: 100 })]);
    const ai = new AiClient({ anthropic: fake, usage, now: () => new Date("2026-10-22T12:00:00Z") });
    await ai.create("digest", { model: "claude-haiku-5-5", max_tokens: 10, messages: [{ role: "user", content: "x" }] }, { transactionId: "t1" });
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]).toMatchObject({ purpose: "digest", inputTokens: 1000, outputTokens: 100, month: "2026-10-01", transactionId: "t1" });
  });

  it("adds the refusal fallback only for fallback-capable models", () => {
    const ai = new AiClient({ anthropic: new FakeAnthropic([]), usage: new InMemoryUsageSink() });
    const sonnet = ai.withRefusalFallback({ model: "claude-sonnet-5-5", max_tokens: 1, messages: [] });
    expect(sonnet.fallbacks).toBe("default");
    expect(sonnet.betas).toContain("server-side-fallback-2026-07-01");
    const haiku = ai.withRefusalFallback({ model: "claude-haiku-5-5", max_tokens: 1, messages: [] });
    expect(haiku.fallbacks).toBeUndefined();
    const off = new AiClient({ anthropic: new FakeAnthropic([]), usage: new InMemoryUsageSink(), refusalFallback: false });
    expect(off.withRefusalFallback({ model: "claude-sonnet-5-5", max_tokens: 1, messages: [] }).fallbacks).toBeUndefined();
  });

  it("the real SDK client satisfies AnthropicLike", () => {
    const conform = (c: Anthropic): AnthropicLike => c;
    expect(typeof conform).toBe("function");
  });
});
