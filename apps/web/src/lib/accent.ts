import { isCustomAccent, isUserAccent } from "@homebase/shared";
import type { CSSProperties } from "react";

/** `<html>` attributes for a user's accent: a named palette, or "custom" with inline light/dark values. */
export function accentAttrs(accent: string | null | undefined): { "data-accent": string; style?: CSSProperties } {
  if (isCustomAccent(accent)) return { "data-accent": "custom", style: customAccentStyle(accent) };
  return { "data-accent": isUserAccent(accent) ? accent : "gold" };
}

/** Dark mode gets a lighter, more luminous version of the same hue. */
export function customAccentStyle(hex: string): CSSProperties {
  return { ["--accent-l" as string]: hex, ["--accent-d" as string]: `color-mix(in srgb, ${hex} 74%, #ffffff)` };
}

/** Apply an accent to the document right away (Settings → You). */
export function applyAccentToDocument(accent: string) {
  const el = document.documentElement;
  if (isCustomAccent(accent)) {
    el.dataset.accent = "custom";
    const s = customAccentStyle(accent) as Record<string, string>;
    for (const [k, v] of Object.entries(s)) el.style.setProperty(k, v);
  } else {
    el.dataset.accent = accent;
    el.style.removeProperty("--accent-l");
    el.style.removeProperty("--accent-d");
  }
}
