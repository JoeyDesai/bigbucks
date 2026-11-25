/**
 * §4.6 guard: every financial connector is read-only.
 * 1. Static scan of src/: no direct fetch outside http.ts, no other HTTP stacks, no non-GET method literal
 *    except the single SimpleFIN claim POST, allowWrite only in simplefin.ts, child_process only in gusto.ts.
 * 2. Runtime: the http wrapper rejects every non-GET method, and the connectors only ever issue GETs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertReadOnly, createHttpClient, WRITE_ALLOWLIST } from "../src/http";
import { ConnectorError } from "../src/types";
import { claimSetupToken, createSimplefinConnector } from "../src/simplefin";
import { createMercuryConnector } from "../src/mercury";
import { createRentcastConnector } from "../src/rentcast";
import { createYnabClient } from "../src/ynab";
import { createMempoolClient } from "../src/xpub";
import { fixtureJson, json, mockFetch, noSleep } from "./helpers";

const SRC = join(import.meta.dirname, "..", "src");

interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}

/** Strip // and /* *\/ comments so prose doesn't trip the scan (keeps line numbers). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

export function scanSource(file: string, source: string): Violation[] {
  const v: Violation[] = [];
  const code = stripComments(source);
  const lines = code.split("\n");
  const base = file.split("/").pop()!;
  lines.forEach((text, i) => {
    const line = i + 1;
    const add = (rule: string) => v.push({ file: base, line, rule, text: text.trim() });
    if (base !== "http.ts" && /(?<![\w.$])fetch\s*\(/.test(text)) add("direct fetch() outside http.ts");
    if (base !== "http.ts" && /globalThis\.fetch|window\.fetch|\bXMLHttpRequest\b/.test(text)) add("global fetch outside http.ts");
    if (/from\s+["'](node:)?(http|https|net|tls|http2)["']|require\(["'](node:)?(http|https)["']\)|from\s+["'](undici|axios|node-fetch|got|ky|superagent)["']/.test(text)) add("alternate HTTP stack");
    for (const m of text.matchAll(/\bmethod\s*[:=]\s*["'`]([A-Za-z]+)["'`]/g)) {
      const meth = m[1]!.toUpperCase();
      if (meth !== "GET" && !(base === "simplefin.ts" && meth === "POST")) add(`non-GET method literal ${meth}`);
    }
    if (/["'`](POST|PUT|PATCH|DELETE)["'`]/.test(text) && base !== "http.ts" && base !== "simplefin.ts") add("write verb literal");
    if (/\ballowWrite\b/.test(text) && base !== "http.ts" && base !== "simplefin.ts") add("allowWrite outside simplefin.ts");
    if (/child_process/.test(text) && base !== "gusto.ts") add("child_process outside gusto.ts");
  });
  if (base === "simplefin.ts") {
    const posts = [...code.matchAll(/\bmethod\s*:\s*["']POST["']/g)];
    if (posts.length > 1) v.push({ file: base, line: 0, rule: "more than one POST in simplefin.ts", text: "" });
    for (const p of posts) {
      const window = code.slice(Math.max(0, p.index! - 200), p.index! + 200);
      if (!/allowWrite:\s*"simplefin\.claim"/.test(window)) v.push({ file: base, line: 0, rule: "POST without simplefin.claim allowlist key", text: window });
      const fnStart = code.lastIndexOf("export async function", p.index!);
      if (!code.slice(fnStart, fnStart + 60).includes("claimSetupToken")) v.push({ file: base, line: 0, rule: "POST outside claimSetupToken", text: "" });
    }
  }
  return v;
}

describe("§4.6 static read-only scan", () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));

  it("finds the connector sources", () => {
    expect(files).toEqual(expect.arrayContaining(["http.ts", "simplefin.ts", "mercury.ts", "coinbase.ts", "ynab.ts", "gusto.ts", "rentcast.ts", "xpub.ts"]));
  });

  for (const f of files) {
    it(`${f} makes no write requests`, () => {
      expect(scanSource(join(SRC, f), readFileSync(join(SRC, f), "utf8"))).toEqual([]);
    });
  }

  it("the scanner itself catches violations", () => {
    expect(scanSource("/x/mercury.ts", `await http.request(u, { method: "POST" });`).map((x) => x.rule)).toContain("non-GET method literal POST");
    expect(scanSource("/x/ynab.ts", `const r = await fetch(url, { method: "DELETE" });`).length).toBeGreaterThanOrEqual(2);
    expect(scanSource("/x/coinbase.ts", `import https from "node:https";`)[0]?.rule).toBe("alternate HTTP stack");
    expect(scanSource("/x/gusto.ts", `const argv = ["api","request","--method","PUT"];`)[0]?.rule).toBe("write verb literal");
    expect(scanSource("/x/mercury.ts", `http.request(u, { allowWrite: "simplefin.claim" })`)[0]?.rule).toBe("allowWrite outside simplefin.ts");
    expect(scanSource("/x/simplefin.ts", `export async function sneaky() { await http.request(u, { method: "POST" }); }`).map((x) => x.rule)).toEqual(
      expect.arrayContaining(["POST without simplefin.claim allowlist key", "POST outside claimSetupToken"]),
    );
    // comments are ignored
    expect(scanSource("/x/mercury.ts", `// never use method: "POST" here`)).toEqual([]);
  });
});

describe("§4.6 runtime guard", () => {
  it("allowlist is exactly the SimpleFIN claim and is frozen", () => {
    expect([...WRITE_ALLOWLIST]).toEqual(["simplefin.claim"]);
    expect(Object.isFrozen(WRITE_ALLOWLIST)).toBe(true);
  });

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "post"]) {
    it(`http wrapper rejects ${method} without touching the network`, async () => {
      const { fetch, calls } = mockFetch(() => json({}));
      const http = createHttpClient({ fetch });
      await expect(http.request("https://api.example.com/x", { method })).rejects.toMatchObject({ code: "read_only_violation" });
      expect(calls).toHaveLength(0);
    });
  }

  it("rejects writes even with a bogus allowWrite key, or a body on the claim", async () => {
    const { fetch, calls } = mockFetch(() => json({}));
    const http = createHttpClient({ fetch });
    await expect(http.request("https://x.example/a", { method: "PUT", allowWrite: "simplefin.claim" })).rejects.toBeInstanceOf(ConnectorError);
    await expect(http.request("https://x.example/a", { method: "POST", allowWrite: "ynab.write" })).rejects.toMatchObject({ code: "read_only_violation" });
    await expect(http.request("https://x.example/a", { method: "POST", allowWrite: "simplefin.claim", body: "{}" })).rejects.toMatchObject({ code: "read_only_violation" });
    expect(calls).toHaveLength(0);
    expect(() => assertReadOnly("GET")).not.toThrow();
    expect(() => assertReadOnly("POST", { allowWrite: "simplefin.claim" })).not.toThrow();
  });

  it("every connector only issues GET (claim POST is the single exception)", async () => {
    const sf = fixtureJson("simplefin-v2.json");
    const { fetch, calls } = mockFetch(
      (u) => (u.pathname.endsWith("/claim/abc") ? new Response("https://user:pass@bridge.example/simplefin") : undefined),
      (u) => (u.hostname === "bridge.example" ? json(sf) : undefined),
      (u) => (u.hostname === "api.mercury.com" && u.pathname.endsWith("/accounts") ? json({ accounts: [], page: {} }) : undefined),
      (u) => (u.hostname === "api.mercury.com" ? json({ transactions: [], page: {} }) : undefined),
      (u) => (u.hostname === "api.rentcast.io" ? json(fixtureJson("rentcast-avm.json")) : undefined),
      (u) => (u.hostname === "api.ynab.com" ? json({ data: { plans: [], default_plan: null } }) : undefined),
      (u) => (u.hostname === "mempool.space" ? json({ address: "bc1q", chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } }) : undefined),
    );
    const http = { fetch, sleep: noSleep };
    const access = await claimSetupToken(Buffer.from("https://bridge.example/simplefin/claim/abc").toString("base64"), http);
    const simplefin = createSimplefinConnector({ http });
    await simplefin.listAccounts({ accessUrl: access });
    await simplefin.fetchTransactions({ accessUrl: access }, { since: "2026-08-01", until: "2026-10-22" });
    const mercury = createMercuryConnector({ http });
    await mercury.listAccounts({ token: "t" });
    await mercury.fetchTransactions({ token: "t" }, { since: "2026-10-01", until: "2026-10-22" });
    await createRentcastConnector({ http }).listAccounts({ apiKey: "k".repeat(16), property: { address: "1 Main St, Fairview, VA" } });
    await createYnabClient("pat", { http }).getPlans();
    await createMempoolClient({ http, minIntervalMs: 0 }).getAddress("bc1q");
    const nonGet = calls.filter((c) => c.method !== "GET");
    expect(nonGet).toHaveLength(1);
    expect(nonGet[0]).toMatchObject({ method: "POST", url: "https://bridge.example/simplefin/claim/abc" });
    expect(nonGet[0]!.body).toBeUndefined();
    expect(calls.length).toBeGreaterThan(6);
  });
});
