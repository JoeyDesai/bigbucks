// @ts-check
// Serwist "configurator mode": `next build` (Turbopack) runs first, then `serwist build`
// bundles src/sw/sw.ts into public/sw.js with a precache manifest of the app shell.
import { serwist } from "@serwist/next/config";

const revision = process.env.HOMEBASE_BUILD_ID ?? String(Date.now());

export default serwist({
  swSrc: "src/sw/sw.ts",
  swDest: "public/sw.js",
  // App shell only: hashed build assets + public icons/manifest + the offline fallback page.
  // Never precache server-rendered pages (they contain household data).
  precachePrerendered: false,
  globIgnores: ["public/sw.js", "public/sw.js.map"],
  additionalPrecacheEntries: [{ url: "/offline", revision }],
});
