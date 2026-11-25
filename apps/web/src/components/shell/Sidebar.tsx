"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { milliToNumber } from "@homebase/shared";
import { BRAND } from "@/lib/brand";
import { cx } from "@/lib/cx";
import { dollars } from "@/lib/format";
import type { AccountVM } from "@/lib/view-models";
import { Sparkline } from "@/components/glow/Sparkline";
import { AccountsNav } from "./AccountsNav";
import { Mark } from "./Mark";
import { NAV, isActive } from "./nav";
import { UserMenu } from "./UserMenu";

export interface SidebarProps {
  accounts: AccountVM[];
  badges?: Record<string, number>;
  /** Σ on-budget balances per day, last ~60 days (oldest first). */
  spark?: bigint[];
}

function setCollapsed(collapsed: boolean) {
  if (collapsed) document.documentElement.dataset.sidebar = "collapsed";
  else delete document.documentElement.dataset.sidebar;
  document.cookie = `hb_sidebar=${collapsed ? "collapsed" : "expanded"}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

/**
 * Desktop left rail (≥1024px): brand, the two tabs (Budget · Transactions), a cash sparkline, the
 * accounts (each opens its page with a balance chart), Connections, and the avatar menu. Collapses to
 * an icon rail (`hb_sidebar` cookie).
 */
export function Sidebar({ accounts, badges = {}, spark = [] }: SidebarProps) {
  const pathname = usePathname();
  const open = accounts.filter((a) => !a.closed);
  const cash = open.filter((a) => a.onBudget).reduce((s, a) => s + a.balance, 0n);
  const first = spark[0];
  const delta = first !== undefined ? cash - first : 0n;

  return (
    <aside aria-label="Sidebar" className="hb-sidebar fixed inset-y-0 left-0 z-30 hidden w-[var(--sidebar-w)] flex-col p-3 lg:flex">
      <div className="glass flex min-h-0 flex-1 flex-col rounded-[22px] shadow-card">
        <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
          <Link href="/budget" className="flex min-w-0 flex-1 items-center gap-2.5" aria-label={`${BRAND.name} home`}>
            <Mark size={30} className="shrink-0 rounded-[9px]" />
            <span className="side-label truncate text-[16px] font-semibold tracking-[-0.02em] text-ink">{BRAND.name}</span>
          </Link>
          <button
            type="button"
            onClick={() => setCollapsed(document.documentElement.dataset.sidebar !== "collapsed")}
            aria-label="Collapse or expand the sidebar"
            title="Collapse or expand the sidebar"
            className="side-label inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-paper-hover hover:text-ink"
          >
            <PanelLeftClose size={17} strokeWidth={1.8} aria-hidden />
          </button>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="Expand the sidebar"
          className="side-icon-only mx-auto mb-2 h-9 w-9 items-center justify-center rounded-lg text-ink-3 hover:bg-paper-hover hover:text-ink"
        >
          <PanelLeftOpen size={17} strokeWidth={1.8} aria-hidden className="mx-auto" />
        </button>

        <nav aria-label="Primary" className="px-2.5">
          <ul className="space-y-1">
            {NAV.map((item) => {
              const active = isActive(pathname, item.href, item.match);
              const Icon = item.icon;
              const count = badges[item.href];
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    title={item.label}
                    className={cx(
                      "relative flex min-h-11 items-center gap-3 rounded-[13px] px-3 text-[14.5px] font-medium transition-all duration-200",
                      active ? "bg-paper text-ink shadow-[0_1px_2px_rgba(16,20,40,0.06),0_6px_18px_-8px_var(--accent-glow)]" : "text-ink-2 hover:bg-paper-hover hover:text-ink",
                    )}
                  >
                    <Icon size={18} strokeWidth={active ? 2.1 : 1.8} aria-hidden className={cx("shrink-0", active ? "text-accent" : "text-ink-3")} />
                    <span className="side-label flex-1">{item.label}</span>
                    {count ? (
                      <span
                        className="side-label num min-w-[22px] rounded-full bg-accent px-1.5 text-center text-[11.5px] font-semibold leading-[20px] text-accent-contrast shadow-[0_0_12px_var(--accent-glow)]"
                        aria-label={`${count} to review`}
                        data-testid="review-badge"
                      >
                        {count}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="side-label mx-2.5 mt-4 rounded-[16px] border border-glass-border bg-paper/60 px-3.5 pb-2 pt-3">
          <div className="eyebrow">Cash &amp; credit</div>
          <div className="mt-1 flex items-end justify-between gap-2">
            <div>
              <div className="num text-[20px] font-semibold tracking-[-0.02em] text-ink">{dollars(cash)}</div>
              {first !== undefined && (
                <div className={cx("num text-[11.5px] font-medium", delta >= 0n ? "text-pos" : "text-ink-3")}>
                  {delta >= 0n ? "+" : "−"}
                  {dollars(delta < 0n ? -delta : delta)} <span className="font-normal text-ink-3">· 60 days</span>
                </div>
              )}
            </div>
            <Sparkline values={spark.map(milliToNumber)} width={96} height={34} />
          </div>
        </div>

        <div className="side-label mt-4 min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
          <AccountsNav accounts={accounts} />
        </div>

        <div className="mt-auto border-t border-rule p-2">
          <UserMenu side="top" align="start" withName />
        </div>
      </div>
    </aside>
  );
}
