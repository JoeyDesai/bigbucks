"use client";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { AccountVM } from "@/lib/view-models";
import { StatusDot, updatedLabel } from "@/components/shell/AccountsNav";
import { UserMenu } from "@/components/shell/UserMenu";

export function AccountHeader({ account }: { account: AccountVM }) {
  return (
    <header className="mb-4 flex items-center gap-2 lg:mb-6">
      <Link href="/accounts" aria-label="All accounts" className="-ml-2 inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-2 hover:bg-paper-hover lg:hidden">
        <ChevronLeft size={20} strokeWidth={2} />
      </Link>
      <div className="min-w-0 flex-1">
        <h1 className="display truncate text-[26px] leading-tight text-ink lg:text-[32px]">{account.name}</h1>
        <p className="flex items-center gap-2 text-[13px] text-ink-3">
          <StatusDot status={account.status} />
          <span className="truncate" suppressHydrationWarning>
            {account.institution} · {updatedLabel(account)}
            {account.onBudget ? "" : " · tracking"}
          </span>
        </p>
      </div>
      <div className="-mr-2 lg:hidden">
        <UserMenu />
      </div>
    </header>
  );
}
