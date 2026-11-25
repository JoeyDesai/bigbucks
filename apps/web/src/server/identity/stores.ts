import "server-only";
import { getDb } from "../db";
import { createDbStores } from "./db-store";
import { createMemoryStores } from "./memory-store";
import type { IdentityStores, User } from "./types";

/**
 * Identity store registry: Postgres (`users`, `sessions`, `pin_attempts`) whenever DATABASE_URL is
 * set, otherwise the in-memory stores (unit tests / a DB-less preview). Stored on globalThis so route
 * handlers, actions and RSC share one instance per process (and survive dev HMR).
 */
const KEY = Symbol.for("homebase.identityStores");
type G = typeof globalThis & { [KEY]?: IdentityStores };

function seedUsers(): User[] {
  return [
    {
      id: "usr_alex",
      displayName: "Alex",
      username: "alex",
      tailscaleLogin: process.env.HOMEBASE_ADMIN_LOGIN ?? "alex@example.com",
      role: "admin",
      accent: "blue",
      passwordHash: null,
    },
    {
      id: "usr_sam",
      displayName: "Sam",
      username: "sam",
      tailscaleLogin: process.env.HOMEBASE_MEMBER_LOGIN ?? "sam@example.com",
      role: "member",
      accent: "pink",
      passwordHash: null,
    },
  ];
}

export function getIdentityStores(): IdentityStores {
  const g = globalThis as G;
  if (!g[KEY]) g[KEY] = process.env.DATABASE_URL ? createDbStores(getDb()) : createMemoryStores(seedUsers());
  return g[KEY];
}

/** Test/second-pass hook: swap in another implementation (e.g. db-backed). */
export function setIdentityStores(stores: IdentityStores): void {
  (globalThis as G)[KEY] = stores;
}
