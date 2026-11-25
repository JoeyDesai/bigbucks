import { dollars } from "@/lib/format";
import { today as localToday, milliToNumber } from "@homebase/shared";
import { requireUser } from "@/server/auth";
import { loadAccounts } from "@/server/queries/transactions";
import { loadCashSpark } from "@/server/queries/glow";
import { AccountsNav } from "@/components/shell/AccountsNav";
import { UserMenu } from "@/components/shell/UserMenu";
import { Sparkline } from "@/components/glow/Sparkline";

export const metadata = { title: "Accounts" };

/** The phone Accounts tab (the sidebar's account list); also a plain overview on desktop. */
export default async function AccountsPage() {
  await requireUser();
  const today = localToday();
  const { accounts } = await loadAccounts(today, { includeClosed: true });
  const spark = await loadCashSpark(today, 90);
  const cash = accounts.filter((a) => a.onBudget && !a.closed).reduce((s, a) => s + a.balance, 0n);
  return (
    <div className="mx-auto w-full max-w-[720px] px-4 pb-6 pt-3 sm:px-6 lg:pt-8">
      <header className="mb-4 flex items-center gap-2 lg:mb-6">
        <h1 className="display flex-1 text-[28px] leading-tight text-ink lg:text-[32px]">Accounts</h1>
        <div className="-mr-2 lg:hidden">
          <UserMenu />
        </div>
      </header>
      <section aria-label="Cash and credit" className="card hb-rise mb-6 flex items-end justify-between gap-4 p-5">
        <div>
          <div className="text-[13px] font-medium text-ink-3">Cash &amp; credit</div>
          <div className="num display mt-1 text-[34px] leading-none text-ink">{dollars(cash)}</div>
          <div className="mt-1.5 text-[12px] text-ink-3">Budget accounts, last 90 days</div>
        </div>
        <Sparkline values={spark.map(milliToNumber)} width={150} height={56} />
      </section>
      <div className="hb-rise">
        <AccountsNav accounts={accounts} size="lg" />
      </div>
    </div>
  );
}
