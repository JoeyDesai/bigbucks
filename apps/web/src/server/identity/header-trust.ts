/**
 * Tailscale identity header trust — pure logic, no Next.js imports (used by src/proxy.ts and tests).
 *
 * Topology (spec §2, §4.1): Next.js listens on 127.0.0.2:3000 — a dedicated loopback alias, NOT
 * 127.0.0.1 — inside the tailscale container's network namespace. Tailscale Serve terminates HTTPS
 * for *.ts.net, injects `Tailscale-User-Login` / `Tailscale-User-Name` / `Tailscale-User-Profile-Pic`,
 * sets `X-Forwarded-For` to the caller's tailnet IP, and proxies to http://127.0.0.2:3000
 * (infra/tailscale/serve.json). Next.js only fills X-Forwarded-For with the socket address when the
 * header is absent (base-server.ts); a client-supplied XFF is kept as-is.
 *
 * Why the alias: in userspace-networking mode tailscaled's netstack forwards inbound tailnet TCP on
 * ANY port to 127.0.0.1:<port> (and [::1]:<port>). A peer could then send `Host: x.ts.net`,
 * `X-Forwarded-For: 100.64.0.1` and `Tailscale-User-Login: <admin>` straight to 100.x:3000 and every
 * header check below would pass. The sidecar now runs in kernel mode (where that forward does not
 * exist), and as a second layer the app binds an address netstack never dials, so even if userspace
 * mode came back the only client that can reach the socket is Serve's proxy. 127.0.0.2 works with no
 * setup on Linux (all of 127.0.0.0/8 is routed to lo); macOS only configures 127.0.0.1, so local dev
 * stays on 127.0.0.1 with header trust off.
 *
 * We trust the Tailscale-* headers only when ALL of these hold:
 *   1. HOMEBASE_TRUST_TAILSCALE_HEADERS=1 (production .env only; off by default).
 *   2. The server is bound to the dedicated loopback alias: HOSTNAME equals HOMEBASE_LISTEN_HOST
 *      (default 127.0.0.2), and that value is an IPv4 address in 127.0.0.0/8 other than 127.0.0.1.
 *      Binding 127.0.0.1 / ::1 / localhost (reachable by the userspace netstack forward) or 0.0.0.0
 *      (reachable by any LAN client) switches trust off.
 *   3. The LAST X-Forwarded-For hop (the one Serve appended) is a Tailscale address
 *      (100.64.0.0/10 or fd7a:115c:a1e0::/48). Client-supplied XFF values sit to the left and
 *      are ignored. (This alone is NOT proof the request came through Serve: a client that reaches
 *      the socket directly controls the whole header. Rule 2 is what makes it meaningful.)
 *   4. Host (or X-Forwarded-Host) is HOMEBASE_PUBLIC_HOST if configured, else ends in ".ts.net".
 *   5. Tailscale-User-Login is present and looks like a login (contains "@" or is a tagged
 *      node name — tagged sources get no identity and fall back to the password login).
 * Otherwise every `Tailscale-*` header is stripped before the request reaches the app.
 * [VERIFY] once deployed: Serve still injects the headers after the node is tagged (§4.3).
 */

export interface TrustEnv {
  trustFlag?: string | undefined; // HOMEBASE_TRUST_TAILSCALE_HEADERS
  listenHost?: string | undefined; // HOSTNAME (what Next.js standalone binds)
  requiredListenHost?: string | undefined; // HOMEBASE_LISTEN_HOST (default 127.0.0.2)
  publicHost?: string | undefined; // HOMEBASE_PUBLIC_HOST
}

export type TrustDecision =
  | { trusted: true; login: string; name: string | null }
  | { trusted: false; reason: string };

type HeaderGetter = { get(name: string): string | null };

/** The loopback alias Next.js binds in production (infra/docker-compose.yml, serve.json). */
export const DEFAULT_LISTEN_HOST = "127.0.0.2";

export function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

/** True for Tailscale CGNAT (100.64.0.0/10) and Tailscale ULA (fd7a:115c:a1e0::/48). */
export function isTailscaleIp(raw: string): boolean {
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) {
    const base = ipv4ToInt("100.64.0.0")!;
    return (v4 & 0xffc00000) >>> 0 === base;
  }
  return /^fd7a:115c:a1e0:/.test(ip);
}

/**
 * True for an IPv4 loopback address other than 127.0.0.1 (e.g. 127.0.0.2). tailscaled's userspace
 * netstack forwards inbound tailnet TCP only to 127.0.0.1 / ::1, so a socket bound here is reachable
 * only by processes in the namespace that dial it on purpose (Serve's proxy).
 */
export function isDedicatedLoopbackAlias(host: string | undefined | null): boolean {
  const v4 = host ? ipv4ToInt(host.trim()) : null;
  if (v4 === null) return false;
  return v4 >>> 24 === 127 && v4 !== ipv4ToInt("127.0.0.1");
}

export function lastForwardedHop(xff: string | null): string | null {
  if (!xff) return null;
  const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
  return hops.at(-1) ?? null;
}

function hostOnly(h: string | null): string | null {
  if (!h) return null;
  const v = h.trim().toLowerCase();
  if (v.startsWith("[")) return v.slice(0, v.indexOf("]") + 1);
  return v.split(":")[0] ?? null;
}

export function evaluateTailscaleTrust(headers: HeaderGetter, env: TrustEnv): TrustDecision {
  if (env.trustFlag !== "1") return { trusted: false, reason: "trust disabled" };
  const required = env.requiredListenHost?.trim() || DEFAULT_LISTEN_HOST;
  if (!isDedicatedLoopbackAlias(required)) return { trusted: false, reason: "HOMEBASE_LISTEN_HOST is not a dedicated loopback alias" };
  if (env.listenHost?.trim() !== required) return { trusted: false, reason: "not bound to the dedicated loopback alias" };

  const hop = lastForwardedHop(headers.get("x-forwarded-for"));
  if (!hop || !isTailscaleIp(hop)) return { trusted: false, reason: "not forwarded from a tailnet address" };

  const hosts = [hostOnly(headers.get("host")), hostOnly(headers.get("x-forwarded-host"))].filter(Boolean) as string[];
  const want = env.publicHost?.trim().toLowerCase();
  const hostOk = want ? hosts.includes(want) : hosts.some((h) => h.endsWith(".ts.net"));
  if (!hostOk) return { trusted: false, reason: "unexpected host" };

  const login = headers.get("tailscale-user-login")?.trim();
  if (!login || !login.includes("@")) return { trusted: false, reason: "no user identity (tagged node or missing header)" };
  return { trusted: true, login, name: headers.get("tailscale-user-name")?.trim() || null };
}

/** Header names the proxy removes when trust is not established. */
export function isTailscaleHeader(name: string): boolean {
  return name.toLowerCase().startsWith("tailscale-");
}

/** Internal headers the proxy sets; any client-supplied copies are always removed. */
export const INTERNAL_HEADER_PREFIX = "x-homebase-";
export const TRUSTED_HEADER = "x-homebase-ts-trusted";
/** Set by the proxy to the verified Cloudflare Access email (src/server/identity/cf-access.ts). */
export const ACCESS_EMAIL_HEADER = "x-homebase-access-email";
export const PATHNAME_HEADER = "x-homebase-pathname";
export const SESSION_COOKIE = "hb_session";
export const THEME_COOKIE = "hb_theme";
