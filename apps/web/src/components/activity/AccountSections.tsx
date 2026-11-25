import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { formatMilli } from "@homebase/shared";
import { accountSections } from "@/lib/account-sections";
import { cx } from "@/lib/cx";
import { timeAgo } from "@/lib/format";
import type { AccountVM } from "@/lib/view-models";
import { StatusDot } from "@/components/ui/StatusDot";

function Balance({ value }: { value: bigint }) {
  return value < 0n ? (
    <span className="pill text-[13.5px]" data-tone="neg">
      {formatMilli(value)}
    </span>
  ) : (
    <span className="num text-[15px] font-semibold text-ink">{formatMilli(value)}</span>
  );
}

/** Phone accounts list (YNAB iOS): rounded cards per group with totals; rows open the account register. */
export function AccountSections({ accounts, className }: { accounts: AccountVM[]; className?: string }) {
  const sections = accountSections(accounts).filter((s) => s.id !== "closed");
  return (
    <div className={cx("space-y-4", className)}>
      {sections.map((s) => (
        <section key={s.id} aria-label={`${s.title} accounts`} className="card overflow-hidden">
          <div className="flex items-center justify-between bg-group px-4 py-2.5">
            <h2 className="text-[13px] font-bold uppercase tracking-[0.06em] text-ink-2">{s.title}</h2>
            <Balance value={s.total} />
          </div>
          <ul>
            {s.accounts.map((a) => (
              <li key={a.id} className="border-t border-rule first:border-t-0">
                <Link href={`/activity/${a.id}`} className="flex min-h-[58px] items-center gap-3 px-4 py-2 hover:bg-paper-hover">
                  <StatusDot status={a.status} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium text-ink">{a.name}</span>
                    <span className="block truncate text-[12px] text-ink-3">
                      {a.institution}
                      {a.updatedAt ? <> · updated {timeAgo(a.updatedAt)}</> : a.status === "manual" ? " · manual" : ""}
                    </span>
                  </span>
                  <Balance value={a.balance} />
                  <ChevronRight size={16} strokeWidth={2} aria-hidden className="text-ink-3" />
                </Link>
                {(a.status === "needs_attention" || a.status === "error") && a.statusNote && (
                  <p className={cx("-mt-1 px-4 pb-2.5 pl-9 text-[12px] leading-snug", a.status === "error" ? "text-neg" : "text-warn")}>{a.statusNote}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
