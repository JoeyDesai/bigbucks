import { describe, expect, it } from "vitest";
import { createHttpClient, redactText, redactUrl } from "../src/http";
import { json, mockFetch } from "./helpers";

describe("http wrapper", () => {
  it("retries 429/5xx with exponential backoff, honoring Retry-After", async () => {
    let n = 0;
    const { fetch, calls } = mockFetch(() => {
      n++;
      if (n === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "2" } });
      if (n === 2) return new Response("bad gateway", { status: 502 });
      return json({ ok: true });
    });
    const waits: number[] = [];
    const http = createHttpClient({ fetch, sleep: async (ms) => void waits.push(ms), backoffBaseMs: 100 });
    expect(await http.getJson("https://api.example.com/x")).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([2000, 200]);
  });

  it("gives up after `retries` and throws a typed error", async () => {
    const { fetch, calls } = mockFetch(() => new Response("nope", { status: 503 }));
    const http = createHttpClient({ fetch, sleep: async () => {}, retries: 2 });
    await expect(http.get("https://api.example.com/x")).rejects.toMatchObject({ code: "http", status: 503 });
    expect(calls).toHaveLength(3);
  });

  it("does not retry 4xx (other than 429)", async () => {
    const { fetch, calls } = mockFetch(() => new Response("unauthorized", { status: 401 }));
    await expect(createHttpClient({ fetch, sleep: async () => {} }).get("https://api.example.com/x")).rejects.toMatchObject({ code: "auth", status: 401 });
    expect(calls).toHaveLength(1);
  });

  it("times out via AbortController and retries network failures", async () => {
    let n = 0;
    const fetch = (_u: string, init?: RequestInit) => {
      n++;
      return new Promise<Response>((resolve, reject) => {
        if (n === 1) init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        else resolve(json({ ok: n }));
      });
    };
    const http = createHttpClient({ fetch, timeoutMs: 20, sleep: async () => {} });
    expect(await http.getJson("https://api.example.com/slow")).toEqual({ ok: 2 });
    const always = createHttpClient({ fetch: (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))), timeoutMs: 10, retries: 0 });
    await expect(always.get("https://api.example.com/slow")).rejects.toMatchObject({ code: "timeout" });
  });

  it("redacts credentials from errors", async () => {
    const { fetch } = mockFetch(() => new Response("token=sk-live-abcdef echo Bearer abc.def.ghi", { status: 400 }));
    const http = createHttpClient({ fetch, secrets: ["sk-live-abcdef"] });
    const err = (await http.get("https://api.example.com/x?api_key=sk-live-abcdef").catch((e) => e)) as Error;
    expect(err.message).not.toContain("sk-live-abcdef");
    expect(err.message).not.toContain("abc.def.ghi");
    expect(redactUrl("https://user:pw@host.example/p?token=1&x=2")).toBe("https://REDACTED@host.example/p?token=REDACTED&x=2");
    expect(redactText("see https://user:pw@host/x and Basic dXNlcjpwdw==")).toBe("see https://REDACTED@host/x and Basic REDACTED");
  });

  it("refuses URLs with embedded credentials (fetch would reject them anyway)", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    await expect(createHttpClient({ fetch }).get("https://u:p@host.example/x")).rejects.toMatchObject({ code: "invalid_input" });
    expect(calls).toHaveLength(0);
  });

  it("encodes query params, repeating arrays, skipping undefined", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    await createHttpClient({ fetch }).get("https://api.example.com/x", { query: { a: "1 2", b: undefined, c: ["x", "y"], d: 3 } });
    expect(calls[0]!.url).toBe("https://api.example.com/x?a=1+2&c=x&c=y&d=3");
  });
});
