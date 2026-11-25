import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), geolocation=(), microphone=(self)" },
  // Private app on a public hostname: never index or archive any of it (the login page included).
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages export TypeScript source directly (no build step), so Next must transpile them.
  transpilePackages: ["@homebase/shared", "@homebase/db", "@homebase/engine", "@homebase/core", "@homebase/ai", "@homebase/categorizer", "@homebase/connectors", "@homebase/worker"],
  // Native / server-only modules stay external to the server bundle.
  serverExternalPackages: ["argon2", "pino", "pg", "pg-boss", "web-push"],
  // Trace files from the monorepo root so the standalone bundle includes workspace packages.
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  typedRoutes: false,
  devIndicators: false,
  experimental: {
    // Reusing the persistent Turbopack dev cache across `next dev` restarts left the HMR client in a
    // reload loop ("HMR hash mismatch" on every request). Cold dev starts are fast enough here.
    turbopackFileSystemCacheForDev: false,
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
