import { generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { clearAccessKeyCache, evaluateAccessJwt, type KeyFetcher } from "./cf-access";

const env = { team: "example-team", aud: "aud-123" };
const NOW = Date.UTC(2026, 9, 27, 12);
const sec = Math.floor(NOW / 1000);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
const keys: KeyFetcher = async () => [jwk];

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
function token(payload: object, opts: { kid?: string; alg?: string; key?: typeof privateKey } = {}) {
  const head = b64({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1" });
  const body = b64(payload);
  return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), opts.key ?? privateKey).toString("base64url")}`;
}
const good = { aud: ["aud-123"], iss: "https://example-team.cloudflareaccess.com", exp: sec + 3600, iat: sec, email: "Member@example.com" };

beforeEach(() => clearAccessKeyCache());

describe("evaluateAccessJwt", () => {
  it("trusts a valid token and lowercases the email", async () => {
    expect(await evaluateAccessJwt(token(good), env, keys, NOW)).toEqual({ trusted: true, email: "member@example.com" });
  });

  it("ignores the header when Access isn't configured", async () => {
    expect((await evaluateAccessJwt(token(good), { team: "example-team" }, keys, NOW)).trusted).toBe(false);
  });

  it.each([
    ["wrong audience", { ...good, aud: ["someone-else"] }],
    ["wrong issuer", { ...good, iss: "https://evil.cloudflareaccess.com" }],
    ["expired", { ...good, exp: sec - 1 }],
    ["no email", { ...good, email: undefined }],
  ])("rejects a token with %s", async (reason, payload) => {
    expect(await evaluateAccessJwt(token(payload), env, keys, NOW)).toEqual({ trusted: false, reason });
  });

  it("rejects a token signed by another key", async () => {
    expect(await evaluateAccessJwt(token(good, { key: other.privateKey }), env, keys, NOW)).toEqual({ trusted: false, reason: "bad signature" });
  });

  it("rejects a forged payload on a real signature", async () => {
    const [h, , s] = token(good).split(".");
    const forged = `${h}.${b64({ ...good, email: "admin@example.com" })}.${s}`;
    expect((await evaluateAccessJwt(forged, env, keys, NOW)).trusted).toBe(false);
  });

  it("rejects alg none and unknown key ids", async () => {
    expect((await evaluateAccessJwt(token(good, { alg: "none" }), env, keys, NOW)).trusted).toBe(false);
    expect(await evaluateAccessJwt(token(good, { kid: "k9" }), env, keys, NOW)).toEqual({ trusted: false, reason: "unknown signing key" });
  });

  it("fails closed when the keys can't be fetched", async () => {
    const down: KeyFetcher = async () => {
      throw new Error("offline");
    };
    expect(await evaluateAccessJwt(token(good), env, down, NOW)).toEqual({ trusted: false, reason: "could not load access keys" });
  });
});
