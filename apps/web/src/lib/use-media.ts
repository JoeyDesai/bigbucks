"use client";
import { useSyncExternalStore } from "react";

/** Live media-query match (false during SSR and the first client render). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** ≥1024px: the sidebar + inspector layout. */
export const useIsDesktop = () => useMediaQuery("(min-width: 1024px)");
