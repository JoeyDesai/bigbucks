/// <reference lib="webworker" />
/**
 * Big Bucks service worker (Serwist). The product name comes from src/lib/brand.ts.
 *
 * Caches the APP SHELL ONLY: hashed `/_next/static/*` assets, icons, the manifest and the
 * `/offline` fallback page. Pages, RSC payloads and `/api/*` are never cached — Postgres on the
 * home server is the only real data store (spec §4.2, §17 "iOS PWA quirks").
 */
import { BRAND } from "../lib/brand";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { NetworkOnly, Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: false,
  runtimeCaching: [
    // Everything that is not precached goes to the network, always. No data caching.
    { matcher: ({ url }) => url.pathname.startsWith("/api/"), handler: new NetworkOnly() },
    { matcher: ({ request }) => request.mode === "navigate", handler: new NetworkOnly() },
  ],
  fallbacks: {
    entries: [{ url: "/offline", matcher: ({ request }) => request.destination === "document" }],
  },
});

serwist.addEventListeners();

// ── Web Push (§11.6). Payload from apps/worker/src/push.ts: {title, body, url?, tag?, type}. ──
interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
  tag?: string;
  type?: string;
}

self.addEventListener("push", (event) => {
  let p: PushPayload = {};
  try {
    p = (event.data?.json() ?? {}) as PushPayload;
  } catch {
    p = { body: event.data?.text() ?? "" };
  }
  const url = typeof p.url === "string" && p.url.startsWith("/") ? p.url : "/budget";
  event.waitUntil(
    self.registration.showNotification(p.title || BRAND.name, {
      body: p.body ?? "",
      tag: p.tag ?? p.type,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | null)?.url ?? "/budget";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin) {
          await w.focus();
          if ("navigate" in w) await (w as WindowClient).navigate(url).catch(() => undefined);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
