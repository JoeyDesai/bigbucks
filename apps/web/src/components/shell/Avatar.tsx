"use client";
import Link from "next/link";
import { cx } from "@/lib/cx";
import { initials } from "@/lib/format";
import { useShellUser } from "./UserContext";

/** Round initial in the user's accent color, linking to Settings (top-right on phones). */
export function Avatar({ className, size = 32 }: { className?: string; size?: number }) {
  const user = useShellUser();
  if (!user) return null;
  return (
    <Link href="/settings" aria-label={`Settings, signed in as ${user.displayName}`} className={cx("inline-flex h-11 w-11 shrink-0 items-center justify-center", className)}>
      <span className="inline-flex items-center justify-center rounded-full bg-accent font-bold text-accent-contrast" style={{ width: size, height: size, fontSize: size * 0.44 }}>
        {initials(user.displayName)}
      </span>
    </Link>
  );
}
