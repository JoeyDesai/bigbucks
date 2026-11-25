"use client";
import { useEffect, useSyncExternalStore } from "react";
import { usePathname, useSearchParams } from "next/navigation";

const KEY = "hb:last-app-page";
/** Pages that are "away" from the app (Settings, the guide): leaving them returns to the last other page. */
const AWAY = ["/settings", "/guide"];
const isAway = (path: string) => AWAY.some((p) => path === p || path.startsWith(`${p}/`));

/** Remembers the last main page (Budget, Transactions, …) so Settings and the guide can go back to it. */
export function RememberAppPage() {
  const pathname = usePathname();
  const search = useSearchParams();
  useEffect(() => {
    if (isAway(pathname)) return;
    const q = search.toString();
    try {
      sessionStorage.setItem(KEY, q ? `${pathname}?${q}` : pathname);
    } catch {}
  }, [pathname, search]);
  return null;
}

const read = () => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};

const LABELS: [string, string][] = [
  ["/budget", "Budget"],
  ["/transactions", "Transactions"],
  ["/reflect", "Reflect"],
  ["/accounts", "Accounts"],
];

/** The page to go back to from Settings or the guide, and its name ("Budget" by default). */
export function useLastAppPage(): { href: string; label: string } {
  const href = useSyncExternalStore(() => () => {}, read, () => null) ?? "/budget";
  const label = LABELS.find(([p]) => href === p || href.startsWith(`${p}/`) || href.startsWith(`${p}?`))?.[1] ?? "the app";
  return { href, label };
}
