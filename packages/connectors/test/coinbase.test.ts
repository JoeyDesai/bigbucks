import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCoinbaseConnector, getCoinbaseSpotPrice, loadCoinbaseKey, mapCoinbaseTransaction, signCoinbaseJwt } from "../src/coinbase";
import { fixtureJson, json, mockFetch } from "./helpers";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pemSec1 = privateKey.export({ type: "sec1", format: "pem" }).toString();
const pemPkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const keyName = "organizations/org-1/apiKeys/key-1";
const creds = { keyName, privateKeyPem: pemSec1 };

const decode = (jwt: string) => {
  const [h, c, s] = jwt.split(".");
  return { header: JSON.parse(Buffer.from(h!, "base64url").toString()), claims: JSON.parse(Buffer.from(c!, "base64url").toString()), sig: Buffer.from(s!, "base64url"), input: `${h}.${c}` };
};

const routes = () =>
  mockFetch((u) => {
    if (u.pathname === "/v2/accounts") return json(fixtureJson(u.searchParams.get("starting_after") ? "coinbase-accounts-p2.json" : "coinbase-accounts-p1.json"));
    if (u.pathname === "/v2/accounts/w-btc/transactions") return json(fixtureJson("coinbase-transactions-btc.json"));
    if (/^\/v2\/accounts\/[^/]+\/transactions$/.test(u.pathname)) return json(fixtureJson("coinbase-transactions-empty.json"));
    if (u.pathname === "/v2/prices/BTC-USD/spot") return json(fixtureJson("coinbase-spot.json"));
    return undefined;
  });

describe("coinbase JWT (ES256, local signing)", () => {
  it("has the documented header/claims and a valid P-256 signature", () => {
    const jwt = signCoinbaseJwt({ keyName, key: pemSec1, method: "GET", path: "/v2/accounts", nowSeconds: 1_792_700_000, nonce: "abc123" });
    const { header, claims, sig, input } = decode(jwt);
    expect(header).toEqual({ alg: "ES256", kid: keyName, nonce: "abc123", typ: "JWT" });
    expect(claims).toEqual({ iss: "cdp", sub: keyName, nbf: 1_792_700_000, exp: 1_792_700_120, uri: "GET api.coinbase.com/v2/accounts" });
    expect(sig).toHaveLength(64); // raw r||s, not DER
    expect(verify("sha256", Buffer.from(input), { key: publicKey, dsaEncoding: "ieee-p1363" }, sig)).toBe(true);
  });

  it("accepts PKCS#8 and escaped-newline PEMs; rejects non-P-256 keys", () => {
    expect(loadCoinbaseKey(pemPkcs8).asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(loadCoinbaseKey(pemSec1.replace(/\n/g, "\\n")).asymmetricKeyType).toBe("ec");
    const ed = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => loadCoinbaseKey(ed)).toThrow(/P-256/);
    const k1 = generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => loadCoinbaseKey(k1)).toThrow(/P-256/);
    expect(() => loadCoinbaseKey("not a key")).toThrow(/PEM/);
  });
});

describe("coinbase connector", () => {
  it("signs a fresh JWT per request with uri = METHOD host path (no query)", async () => {
    const { fetch, calls } = routes();
    await createCoinbaseConnector({ http: { fetch } }).fetchHoldings!(creds);
    expect(calls).toHaveLength(2);
    const [a, b] = calls.map((c) => decode(c.headers.authorization!.replace(/^Bearer /, "")));
    expect(a!.claims.uri).toBe("GET api.coinbase.com/v2/accounts");
    expect(b!.claims.uri).toBe("GET api.coinbase.com/v2/accounts");
    expect(a!.header.nonce).not.toBe(b!.header.nonce);
    expect(verify("sha256", Buffer.from(b!.input), { key: publicKey, dsaEncoding: "ieee-p1363" }, b!.sig)).toBe(true);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("maps wallets to holdings on one Coinbase crypto account (paginated, zero balances skipped)", async () => {
    const { fetch } = routes();
    const c = createCoinbaseConnector({ http: { fetch }, now: () => Date.parse("2026-10-22T23:00:00Z") });
    const holdings = await c.fetchHoldings!(creds);
    expect(holdings.map((h) => [h.symbol, h.shares, h.marketValue])).toEqual([
      ["BTC", "0.12345678", 8_271_600n],
      ["ETH", "1.5", 3_900_000n],
      ["USD", "25.1", 25_100n],
    ]);
    expect(holdings.every((h) => h.accountExternalId === "coinbase")).toBe(true);
    const [acct] = await c.listAccounts(creds);
    expect(acct).toMatchObject({ externalId: "coinbase", name: "Coinbase", kindGuess: "crypto", balance: 12_196_700n, asOf: "2026-10-22T23:00:00.000Z" });
  });

  it("maps transactions in the window; skips failed; pending flagged", async () => {
    const { fetch, calls } = routes();
    const txns = await createCoinbaseConnector({ http: { fetch } }).fetchTransactions(creds, { since: "2026-10-01", until: "2026-10-22" });
    expect(txns.map((t) => t.externalId)).toEqual(["t-buy-1", "t-send-1"]);
    expect(txns[0]).toMatchObject({ amount: 670_000n, description: "Bought Bitcoin — Using USD Wallet", asset: { symbol: "BTC", quantity: "0.01" }, pending: false, date: "2026-10-05" });
    expect(txns[1]).toMatchObject({ amount: -335_000n, pending: true, postedAt: null, memo: "to cold storage", date: "2026-10-20", asset: { quantity: "-0.005" } });
    expect(calls.filter((c) => c.url.includes("/transactions"))).toHaveLength(4);
    expect(mapCoinbaseTransaction({ id: "x", type: "send", status: "expired", amount: { amount: "1", currency: "BTC" }, created_at: "2026-01-01T00:00:00Z" })).toBeNull();
  });

  it("public spot price (no auth header)", async () => {
    const { fetch, calls } = routes();
    expect(await getCoinbaseSpotPrice("BTC-USD", { fetch })).toEqual({ base: "BTC", currency: "USD", price: 67_123_450n });
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });
});
