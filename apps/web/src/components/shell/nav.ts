import { ArrowLeftRight, ChartColumnBig, ChartPie, Landmark, ListTree, MessageCircle, TrendingUp, Wallet, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shorter label for the phone tab bar. */
  short?: string;
  /** Other path prefixes that count as this item. */
  match?: string[];
}

/** The main tabs (ADR "Web: simple bucket budget (glow)"). */
export const NAV: NavItem[] = [
  { href: "/budget", label: "Budget", icon: Wallet },
  { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { href: "/investments", label: "Investments", short: "Invest", icon: TrendingUp },
  { href: "/reflect", label: "Reflect", icon: ChartPie },
];

/** Phone tab bar: the main tabs plus Accounts (the sidebar's account list). */
export const PHONE_TABS: NavItem[] = [...NAV, { href: "/accounts", label: "Accounts", icon: Landmark }];

/** Older and advanced screens: still routed, linked only from the avatar menu's "More". */
export const MORE: NavItem[] = [
  { href: "/plan", label: "Classic plan", icon: ListTree },
  { href: "/reports", label: "Reports", icon: ChartColumnBig },
  { href: "/wealth", label: "Wealth", icon: TrendingUp },
  { href: "/ask", label: "Ask", icon: MessageCircle },
  { href: "/activity", label: "Account registers", icon: Landmark },
];

export function isActive(pathname: string, href: string, match: string[] = []): boolean {
  return [href, ...match].some((h) => pathname === h || pathname.startsWith(`${h}/`));
}
