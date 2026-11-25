import { CircleDot } from "lucide-react";
import { cx } from "@/lib/cx";
import { iconKeyFor } from "@/lib/category-icons";
import { CATEGORY_ICONS } from "./icon-map";

export const hasCategoryIcon = (key: string) => key in CATEGORY_ICONS;

/**
 * A category's lucide icon, tinted subtly with the user's accent. `icon` is the stored key; when it's
 * null the name's keywords pick one. Purely decorative (the name is always next to it).
 */
export function CategoryIcon({ icon, name, size = 16, className, strokeWidth = 1.9, tone = "subtle" }: { icon?: string | null; name: string; size?: number; className?: string; strokeWidth?: number; tone?: "subtle" | "accent" | "inherit" }) {
  const key = iconKeyFor(icon, name, hasCategoryIcon);
  const Icon = CATEGORY_ICONS[key] ?? CircleDot;
  return <Icon size={size} strokeWidth={strokeWidth} aria-hidden className={cx("shrink-0", tone === "subtle" ? "text-icon-tint" : tone === "accent" ? "text-accent" : "", className)} data-icon={key} />;
}
