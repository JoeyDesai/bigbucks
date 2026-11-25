/**
 * Request proxy (Next.js 16's renamed "middleware"; runs in the Node.js runtime).
 *
 * 1. Always removes client-supplied `x-homebase-*` headers.
 * 2. Decides whether the `Tailscale-*` identity headers can be trusted (see
 *    src/server/identity/header-trust.ts for the full rules). If not, strips them all.
 * 3. Verifies a Cloudflare Access JWT (when Access guards the public hostname) and passes on its email; see
 *    src/server/identity/cf-access.ts.
 * 4. Optimistic auth gate: a request with no trusted identity, no session cookie and no dev
 *    bypass is redirected to /login (pages) or gets 401 (API). Real validation of the session
 *    happens server-side in `getCurrentUser()` (src/server/auth.ts).
 */
import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_JWT_HEADER, evaluateAccessJwt } from "./server/identity/cf-access";
import {
  ACCESS_EMAIL_HEADER,
  INTERNAL_HEADER_PREFIX,
  PATHNAME_HEADER,
  SESSION_COOKIE,
  TRUSTED_HEADER,
  evaluateTailscaleTrust,
  isTailscaleHeader,
} from "./server/identity/header-trust";

const PUBLIC_PATHS = ["/login", "/health", "/offline", "/api/health", "/robots.txt"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function proxy(req: NextRequest) {
  const headers = new Headers(req.headers);
  for (const name of [...headers.keys()]) {
    if (name.startsWith(INTERNAL_HEADER_PREFIX)) headers.delete(name);
  }

  const decision = evaluateTailscaleTrust(req.headers, {
    trustFlag: process.env.HOMEBASE_TRUST_TAILSCALE_HEADERS,
    listenHost: process.env.HOSTNAME,
    requiredListenHost: process.env.HOMEBASE_LISTEN_HOST,
    publicHost: process.env.HOMEBASE_PUBLIC_HOST,
  });
  if (decision.trusted) {
    headers.set(TRUSTED_HEADER, "1");
  } else {
    for (const name of [...headers.keys()]) if (isTailscaleHeader(name)) headers.delete(name);
  }

  const access = await evaluateAccessJwt(req.headers.get(ACCESS_JWT_HEADER), {
    team: process.env.HOMEBASE_CF_ACCESS_TEAM,
    aud: process.env.HOMEBASE_CF_ACCESS_AUD,
  });
  if (access.trusted) headers.set(ACCESS_EMAIL_HEADER, access.email);

  const { pathname, search } = req.nextUrl;
  headers.set(PATHNAME_HEADER, pathname + search);

  const devBypass = process.env.NODE_ENV === "development" && !!process.env.HOMEBASE_DEV_USER;
  const demo = process.env.HOMEBASE_DEMO === "1";
  const identified = decision.trusted || access.trusted || req.cookies.has(SESSION_COOKIE) || devBypass || demo;

  if (!identified && !isPublic(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    // Everything except Next internals (build assets, image optimizer, dev HMR socket and
    // overlay endpoints) and static PWA files. Gating /_next/webpack-hmr made the dev client
    // reload in a loop on /login.
    "/((?!_next/|__nextjs|icons/|icon.svg|favicon.ico|apple-touch-icon.png|manifest.webmanifest|sw.js|swe-worker-).*)",
  ],
};
