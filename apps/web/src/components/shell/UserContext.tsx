"use client";
import { createContext, useContext, type ReactNode } from "react";
import type { Accent } from "@/server/identity/types";

export interface ShellUser {
  displayName: string;
  role: "admin" | "member";
  via: "access" | "tailscale" | "session" | "dev" | "demo";
  /** Tailscale login (shown under the name in the sidebar), when known. */
  email?: string | null;
  accent?: Accent | null;
}

const Ctx = createContext<ShellUser | null>(null);

export function UserProvider({ user, children }: { user: ShellUser; children: ReactNode }) {
  return <Ctx.Provider value={user}>{children}</Ctx.Provider>;
}

export function useShellUser(): ShellUser | null {
  return useContext(Ctx);
}
