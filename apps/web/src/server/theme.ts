import "server-only";
import { cookies } from "next/headers";
import { THEME_COOKIE } from "./identity/header-trust";
import type { ThemePref } from "@/components/shell/ThemeToggle";

export const SIDEBAR_COOKIE = "hb_sidebar";

/** Dark (to match the dark-and-gold brand) unless the household picked Light or System in Settings. */
export async function getThemePref(): Promise<ThemePref> {
  const v = (await cookies()).get(THEME_COOKIE)?.value;
  return v === "light" || v === "system" ? v : "dark";
}

/** Desktop sidebar: expanded (default) or collapsed to an icon rail. */
export async function getSidebarPref(): Promise<"expanded" | "collapsed"> {
  return (await cookies()).get(SIDEBAR_COOKIE)?.value === "collapsed" ? "collapsed" : "expanded";
}
