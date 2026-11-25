"use client";
import { useState } from "react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

export type ThemePref = "light" | "dark" | "system";

/** Apply a theme now and remember it in the `hb_theme` cookie (read server-side, so there is no flash). */
export function applyTheme(pref: ThemePref) {
  document.documentElement.dataset.theme = pref;
  document.cookie = `hb_theme=${pref}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

/** Light (default) / Dark / Match system. */
export function ThemeToggle({ initial }: { initial: ThemePref }) {
  const [pref, setPref] = useState<ThemePref>(initial);
  return (
    <SegmentedControl<ThemePref>
      label="Appearance"
      value={pref}
      onChange={(p) => {
        setPref(p);
        applyTheme(p);
      }}
      options={[
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
        { value: "system", label: "Match system" },
      ]}
    />
  );
}
