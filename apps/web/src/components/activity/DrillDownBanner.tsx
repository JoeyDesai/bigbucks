"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { categoryLabel } from "@/lib/category-icons";
import { formatDay } from "@/lib/format";
import type { AccountVM, CategoryOption } from "@/lib/view-models";
import type { PayeeOption } from "@/server/queries/scheduled";
import type { RegisterQuery } from "@/server/queries/transactions";

/** "Showing: 🛒 Groceries · Oct 1 – Oct 31" for Reports drill-downs, with a way back to everything. */
export function DrillDownBanner({ query, categoryOptions, payees, accounts }: { query: RegisterQuery; categoryOptions: CategoryOption[]; payees: PayeeOption[]; accounts: AccountVM[] }) {
  const pathname = usePathname();
  const parts: string[] = [];
  if (query.categoryIds?.length) parts.push(query.categoryIds.map((id) => categoryLabel(categoryOptions.find((o) => o.id === id)?.name ?? "a category")).join(", "));
  if (query.payeeIds?.length) parts.push(query.payeeIds.map((id) => payees.find((p) => p.id === id)?.name ?? "a payee").join(", "));
  if (query.accountId && pathname === "/activity") parts.push(accounts.find((a) => a.id === query.accountId)?.name ?? "an account");
  if (query.from || query.to) parts.push(`${query.from ? formatDay(query.from, { withYear: true }) : "…"} – ${query.to ? formatDay(query.to, { withYear: true }) : "today"}`);
  if (!parts.length) return null;
  return (
    <div className="mb-3 flex items-center gap-3 rounded-lg bg-accent-soft py-1.5 pl-3 pr-1 text-[13px]">
      <span className="min-w-0 flex-1 text-ink-2">
        Showing <span className="text-ink">{parts.join(" · ")}</span>
      </span>
      <Link href={pathname} aria-label="Clear filters" className="inline-flex h-9 w-9 shrink-0 items-center justify-center text-ink-3 hover:text-ink">
        <X size={16} strokeWidth={1.75} />
      </Link>
    </div>
  );
}
