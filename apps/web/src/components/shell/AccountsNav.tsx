"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Link2 } from "lucide-react";
import { formatMilli } from "@homebase/shared";
import { accountSections } from "@/lib/account-sections";
import { cx } from "@/lib/cx";
import { timeAgo, dollars } from "@/lib/format";
import type { AccountVM, ConnectionStatus } from "@/lib/view-models";
import { useShellUser } from "./UserContext";

const DOT: Record<ConnectionStatus, { cls: string; label: string }> = {
  ok: { cls: "bg-pos-bar shadow-[0_0_8px_color-mix(in_srgb,var(--pos-bar)_70%,transparent)]", label: "Connected" },
  needs_attention: { cls: "bg-amber shadow-[0_0_8px_color-mix(in_srgb,var(--amber)_70%,transparent)]", label: "Needs attention" },
  error: { cls: "bg-over shadow-[0_0_8px_var(--over-glow)]", label: "Not syncing" },
  disabled: { cls: "bg-ink-3/50", label: "Disabled" },
  manual: { cls: "bg-ink-3/45", label: "Manual" },
};

export function StatusDot({ status, className }: { status: ConnectionStatus; className?: string }) {
  const d = DOT[status];
  return (
    <>
      <span aria-hidden className={cx("inline-block h-[7px] w-[7px] shrink-0 rounded-full", d.cls, className)} />
      <span className="sr-only">{d.label}</span>
    </>
  );
}

export function updatedLabel(a: AccountVM): string {
  if (!a.updatedAt) return a.status === "manual" ? "Manual" : "Not synced yet";
  return `Updated ${timeAgo(a.updatedAt)}`;
}

/**
 * Accounts grouped Cash · Credit · Tracking, each with its balance, connection dot and "updated X ago",
 * then a Connections entry. Used by the desktop sidebar and the phone Accounts tab (`size="lg"`).
 */
export function AccountsNav({ accounts, size = "sm", onNavigate }: { accounts: AccountVM[]; size?: "sm" | "lg"; onNavigate?: () => void }) {
  const pathname = usePathname();
  const user = useShellUser();
  const sections = accountSections(accounts).filter((s) => s.id !== "closed");
  const lg = size === "lg";
  return (
    <div className={cx(lg ? "space-y-6" : "space-y-4")}>
      {sections.map((s) => (
        <section key={s.id} aria-label={`${s.title} accounts`}>
          <div className={cx("flex items-baseline justify-between", lg ? "mb-2 px-1" : "mb-1 px-3")}>
            <h2 className="eyebrow">{s.title}</h2>
            <span className={cx("num font-medium text-ink-3", lg ? "text-[13px]" : "text-[11.5px]")}>{dollars(s.total)}</span>
          </div>
          <ul className={cx(lg && "card overflow-hidden")}>
            {s.accounts.map((a) => {
              const href = `/accounts/${a.id}`;
              const here = pathname === href;
              return (
                <li key={a.id} className={cx(lg && "border-t border-rule first:border-t-0")}>
                  <Link
                    href={href}
                    onClick={onNavigate}
                    aria-current={here ? "page" : undefined}
                    data-account-id={a.id}
                    className={cx(
                      "group relative flex items-center gap-3 transition-colors",
                      lg ? "min-h-[64px] px-4" : "min-h-[46px] rounded-[12px] px-3",
                      here ? "bg-accent-soft" : "hover:bg-paper-hover",
                    )}
                  >
                    {here && !lg && <span aria-hidden className="absolute inset-y-2.5 left-0 w-[3px] rounded-full bg-accent shadow-[0_0_10px_var(--accent-glow)]" />}
                    <StatusDot status={a.status} />
                    <span className="min-w-0 flex-1">
                      <span className={cx("block truncate font-medium text-ink", lg ? "text-[15.5px]" : "text-[13.5px]")}>{a.name}</span>
                      <span className={cx("block truncate text-ink-3", lg ? "text-[12.5px]" : "text-[11.5px]")} suppressHydrationWarning>
                        {updatedLabel(a)}
                      </span>
                    </span>
                    <span className={cx("num shrink-0 font-medium", a.balance < 0n ? "text-ink-2" : "text-ink", lg ? "text-[15px]" : "text-[13px]")}>{formatMilli(a.balance)}</span>
                    {lg && <ChevronRight size={16} strokeWidth={2} aria-hidden className="text-ink-3" />}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <Link
        href={user?.role === "admin" ? "/settings/connections" : "/settings/imports"}
        onClick={onNavigate}
        className={cx("flex items-center gap-3 text-ink-2 transition-colors hover:bg-paper-hover hover:text-ink", lg ? "card min-h-[56px] px-4 text-[15px]" : "min-h-10 rounded-[12px] px-3 text-[13.5px]")}
      >
        <Link2 size={lg ? 18 : 16} strokeWidth={1.9} aria-hidden className="text-icon-tint" />
        <span className="flex-1 font-medium">Connections</span>
        {lg && <ChevronRight size={16} strokeWidth={2} aria-hidden className="text-ink-3" />}
      </Link>
    </div>
  );
}
