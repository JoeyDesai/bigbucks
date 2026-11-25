"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Keyboard, LogOut, Monitor, Moon, Settings, Sun } from "lucide-react";
import { cx } from "@/lib/cx";
import { initials } from "@/lib/format";
import { signOutAction } from "@/server/actions";
import { ActionMenu, type ActionMenuItem } from "@/components/ui/ActionMenu";
import { MORE } from "./nav";
import { applyTheme, type ThemePref } from "./ThemeToggle";
import { useShellUser } from "./UserContext";

/** The user's initial in their accent, with a soft glow. */
export function AvatarDot({ size = 32, className }: { size?: number; className?: string }) {
  const user = useShellUser();
  return (
    <span
      aria-hidden
      className={cx("inline-flex shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-accent-contrast shadow-[0_0_0_3px_var(--accent-soft),0_4px_14px_-4px_var(--accent-glow)]", className)}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {initials(user?.displayName ?? "?")}
    </span>
  );
}

/**
 * Avatar menu: Settings, theme (light / dark / system), keyboard shortcuts, and "More" — the older
 * screens (Classic plan, Reports, Wealth, Ask, account registers) that are no longer in the main nav.
 */
export function UserMenu({ side = "bottom", align = "end", withName, className }: { side?: "top" | "bottom"; align?: "start" | "end"; withName?: boolean; className?: string }) {
  const router = useRouter();
  const user = useShellUser();
  const [chosen, setPref] = useState<ThemePref | null>(null);
  // The menu only renders its items once opened (client side), so reading the document here is safe.
  const pref: ThemePref = chosen ?? (typeof document !== "undefined" ? ((document.documentElement.dataset.theme as ThemePref | undefined) ?? "light") : "light");
  const pick = (p: ThemePref) => {
    setPref(p);
    applyTheme(p);
  };
  const items: ActionMenuItem[] = [
    { type: "heading", id: "who", label: user ? `${user.displayName} · ${user.role === "admin" ? "Admin" : "Member"}` : "Account" },
    { id: "settings", label: "Settings", icon: <Settings size={16} strokeWidth={1.8} />, onSelect: () => router.push("/settings") },
    { id: "guide", label: "How it works", icon: <BookOpen size={16} strokeWidth={1.8} />, onSelect: () => router.push("/guide") },
    { id: "keys", label: "Keyboard shortcuts", icon: <Keyboard size={16} strokeWidth={1.8} />, onSelect: () => window.dispatchEvent(new CustomEvent("hb:shortcuts")) },
    { type: "separator", id: "s1" },
    { type: "heading", id: "theme", label: "Appearance" },
    { id: "light", label: "Light", icon: <Sun size={16} strokeWidth={1.8} />, checked: pref === "light", onSelect: () => pick("light") },
    { id: "dark", label: "Dark", icon: <Moon size={16} strokeWidth={1.8} />, checked: pref === "dark", onSelect: () => pick("dark") },
    { id: "system", label: "Match system", icon: <Monitor size={16} strokeWidth={1.8} />, checked: pref === "system", onSelect: () => pick("system") },
    { type: "separator", id: "s2" },
    { type: "heading", id: "more", label: "More" },
    ...MORE.map((m) => {
      const Icon = m.icon;
      return { id: m.href, label: m.label, icon: <Icon size={16} strokeWidth={1.8} />, onSelect: () => router.push(m.href) };
    }),
    ...(user?.via === "session" ? [{ type: "separator" as const, id: "s3" }, { id: "out", label: "Sign out", icon: <LogOut size={16} strokeWidth={1.8} />, onSelect: () => void signOutAction() }] : []),
    // Cloudflare Access owns this sign-in; its logout endpoint clears the Access cookie.
    ...(user?.via === "access" ? [{ type: "separator" as const, id: "s3" }, { id: "out", label: "Sign out", icon: <LogOut size={16} strokeWidth={1.8} />, onSelect: () => window.location.assign("/cdn-cgi/access/logout") }] : []),
  ];
  return (
    <ActionMenu
      label={`Account menu for ${user?.displayName ?? "you"}`}
      side={side}
      align={align}
      block={withName}
      items={items}
      triggerClassName={cx("flex items-center gap-2.5 rounded-full outline-none", withName ? "w-full rounded-[14px] p-2 text-left hover:bg-paper-hover" : "h-11 w-11 justify-center", className)}
      trigger={
        <>
          <AvatarDot size={withName ? 34 : 32} />
          {withName && (
            <span className="side-label min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold text-ink">{user?.displayName}</span>
              <span className="block truncate text-[12px] text-ink-3">{user?.email ?? (user?.role === "admin" ? "Admin" : "Member")}</span>
            </span>
          )}
        </>
      }
    />
  );
}
