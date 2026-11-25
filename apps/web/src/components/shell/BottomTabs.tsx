"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/lib/cx";
import { PHONE_TABS, isActive } from "./nav";

/** Phone tab bar (< 1024px): Budget · Transactions · Invest · Reflect · Accounts, frosted, above the home indicator. */
export function BottomTabs({ badges = {} }: { badges?: Record<string, number> }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 px-3 pb-[calc(var(--safe-bottom)+8px)] pl-[calc(var(--safe-left)+12px)] pr-[calc(var(--safe-right)+12px)] lg:hidden">
      <ul className="glass mx-auto grid h-[var(--tabbar-h)] max-w-[480px] grid-cols-5 rounded-[22px] px-1.5 shadow-pop">
        {PHONE_TABS.map((t) => {
          const active = isActive(pathname, t.href, t.match) || (t.href === "/accounts" && pathname.startsWith("/accounts"));
          const Icon = t.icon;
          const count = badges[t.href];
          return (
            <li key={t.href} className="relative flex">
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cx("relative my-1.5 flex flex-1 flex-col items-center justify-center gap-0.5 rounded-[16px] text-[11px] font-semibold transition-colors", active ? "text-accent" : "text-ink-3")}
              >
                {active && <span aria-hidden className="absolute inset-0 rounded-[16px] bg-accent-soft" style={{ animation: "hb-fade-in 200ms ease-out" }} />}
                <span className="relative">
                  <Icon size={22} strokeWidth={active ? 2.2 : 1.8} aria-hidden />
                  {count ? (
                    <span className="num absolute -right-3 -top-1.5 min-w-[18px] rounded-full bg-accent px-1 text-center text-[10px] font-bold leading-[18px] text-accent-contrast shadow-[0_0_10px_var(--accent-glow)]" aria-label={`${count} to review`}>
                      {count > 99 ? "99+" : count}
                    </span>
                  ) : null}
                </span>
                <span className="relative">{t.short ?? t.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
