import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getAccount, lastReconciliation, NotFoundError } from "@homebase/core";
import { monthOf, today as localToday } from "@homebase/shared";
import { getDb } from "@/server/db";
import { requireUser } from "@/server/auth";
import { loadCategoryOptions, loadRecentCategoryIds } from "@/server/queries/plan";
import { loadPayeeOptions, loadScheduled } from "@/server/queries/scheduled";
import { loadAccounts, loadRegister, parseRegisterParams, toAccountVM } from "@/server/queries/transactions";
import { AccountRegisterView } from "./AccountRegisterView";

export default async function AccountRegisterPage({ params, searchParams }: { params: Promise<{ accountId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const cu = await requireUser();
  const { accountId } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(accountId)) notFound();
  const today = localToday();
  const db = getDb();
  const summary = await getAccount(db, accountId, { today }).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const { accounts } = await loadAccounts(today);
  const account = accounts.find((a) => a.id === accountId) ?? toAccountVM(summary, null);
  const query = parseRegisterParams(sp, accountId);
  const register = await loadRegister(query);
  const last = await lastReconciliation(db, accountId);
  const options = await loadCategoryOptions(monthOf(today), today);
  const recent = await loadRecentCategoryIds(cu.user.id);
  const scheduled = (await loadScheduled(today)).filter((s) => s.accountId === accountId || s.transferAccountId === accountId);
  const payees = await loadPayeeOptions();
  return (
    <>
      <div className="px-2 pt-2 lg:hidden">
        <Link href="/activity" className="inline-flex min-h-11 items-center gap-1 px-2 text-[14px] font-semibold text-accent">
          <ChevronLeft size={18} strokeWidth={2.2} aria-hidden /> Accounts
        </Link>
      </div>
      <AccountRegisterView
        account={account}
        summary={{ cleared: summary.clearedBalance, uncleared: summary.unclearedBalance, working: summary.workingBalance, pending: summary.pendingAmount }}
        lastReconciled={last ? { at: last.at.toISOString(), balance: last.statementBalanceMilli } : null}
        accounts={accounts}
        register={register}
        query={query}
        categoryOptions={options}
        recentCategoryIds={recent}
        scheduled={scheduled}
        payees={payees}
      />
    </>
  );
}
