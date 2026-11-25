/**
 * Cloudflare Access identity — pure logic plus a cached key fetch, no Next.js imports (used by
 * src/proxy.ts and tests).
 *
 * Topology: the public hostname → Cloudflare Access (only the allowed emails get past the login
 * screen) → Cloudflare Tunnel → the `cloudflared` container, which shares the tailscale container's
 * network namespace and proxies to http://127.0.0.2:3000. Access adds `Cf-Access-Jwt-Assertion`, an
 * RS256 JWT signed with the team's keys, to every request it lets through.
 *
 * We trust it only when the signature verifies against https://<team>.cloudflareaccess.com/cdn-cgi/access/certs,
 * `aud` contains this app's Application Audience tag, `iss` is the team domain, it hasn't expired and
 * it carries an email. Both HOMEBASE_CF_ACCESS_TEAM and HOMEBASE_CF_ACCESS_AUD must be set; otherwise
 * the header is ignored. The email then has to match a `users.email` row (src/server/auth.ts).
 */
import { createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";

export interface AccessEnv {
  team?: string | undefined; // HOMEBASE_CF_ACCESS_TEAM, e.g. "your-team" (<team>.cloudflareaccess.com)
  aud?: string | undefined; // HOMEBASE_CF_ACCESS_AUD (the Access application's audience tag)
}

export type AccessDecision = { trusted: true; email: string } | { trusted: false; reason: string };

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

type Jwk = JsonWebKey & { kid?: string };
export type KeyFetcher = (url: string) => Promise<Jwk[]>;

const KEY_TTL_MS = 60 * 60 * 1000;
const REFETCH_GAP_MS = 60 * 1000;
const cache = new Map<string, { keys: Map<string, KeyObject>; at: number }>();

const fetchKeys: KeyFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`access certs ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  return body.keys ?? [];
};

function b64json(part: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The signing key for `kid`, from cache; refetched hourly, or (at most once a minute) on an unknown kid. */
async function keyFor(team: string, kid: string, fetcher: KeyFetcher, now: number): Promise<KeyObject | null> {
  const url = `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`;
  let hit = cache.get(url);
  const stale = !hit || now - hit.at > KEY_TTL_MS || (!hit.keys.has(kid) && now - hit.at > REFETCH_GAP_MS);
  if (stale) {
    const keys = new Map<string, KeyObject>();
    for (const k of await fetcher(url)) if (k.kid && k.kty === "RSA") keys.set(k.kid, createPublicKey({ key: k, format: "jwk" }));
    hit = { keys, at: now };
    cache.set(url, hit);
  }
  return hit!.keys.get(kid) ?? null;
}

export async function evaluateAccessJwt(token: string | null, env: AccessEnv, fetcher: KeyFetcher = fetchKeys, now = Date.now()): Promise<AccessDecision> {
  const team = env.team?.trim();
  const aud = env.aud?.trim();
  if (!team || !aud) return { trusted: false, reason: "access not configured" };
  if (!/^[a-z0-9-]+$/i.test(team)) return { trusted: false, reason: "bad team name" };
  if (!token) return { trusted: false, reason: "no access token" };

  const parts = token.split(".");
  if (parts.length !== 3) return { trusted: false, reason: "malformed token" };
  const [h, p, s] = parts as [string, string, string];
  const header = b64json(h);
  const payload = b64json(p);
  if (!header || !payload) return { trusted: false, reason: "malformed token" };
  if (header.alg !== "RS256" || typeof header.kid !== "string") return { trusted: false, reason: "unexpected algorithm" };

  let key: KeyObject | null;
  try {
    key = await keyFor(team, header.kid, fetcher, now);
  } catch {
    return { trusted: false, reason: "could not load access keys" };
  }
  if (!key) return { trusted: false, reason: "unknown signing key" };
  if (!verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))) return { trusted: false, reason: "bad signature" };

  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return { trusted: false, reason: "wrong audience" };
  if (payload.iss !== `https://${team}.cloudflareaccess.com`) return { trusted: false, reason: "wrong issuer" };
  const sec = Math.floor(now / 1000);
  if (typeof payload.exp !== "number" || payload.exp < sec) return { trusted: false, reason: "expired" };
  if (typeof payload.nbf === "number" && payload.nbf > sec + 60) return { trusted: false, reason: "not yet valid" };
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!email.includes("@")) return { trusted: false, reason: "no email" };
  return { trusted: true, email };
}

/** Test hook: forget cached keys. */
export function clearAccessKeyCache(): void {
  cache.clear();
}
