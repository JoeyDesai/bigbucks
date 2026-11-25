import { today as localToday } from "@homebase/shared";
import { requireUser } from "@/server/auth";
import { loadCategoryChoices, loadRecentChoiceIds, loadTxPage } from "@/server/queries/glow";
import { loadAccounts } from "@/server/queries/transactions";
import { TxList } from "@/components/glow/TxList";
import { UserMenu } from "@/components/shell/UserMenu";

export const metadata = { title: "Transactions" };

/** One fast list. Default "Needs review" (uncategorized or unapproved); `?view=all` shows everything; `?q=` searches. */
export default async function TransactionsPage({ searchParams }: { searchParams: Promise<{ view?: string; q?: string }> }) {
  const cu = await requireUser();
  const sp = await searchParams;
  const mode = sp.view === "all" ? "all" : "review";
  const q = sp.q?.slice(0, 200) || undefined;
  const choices = await loadCategoryChoices();
  const page = await loadTxPage({ mode, q }, choices);
  const recent = await loadRecentChoiceIds(cu.user.id);
  const { accounts } = await loadAccounts(localToday());
  return (
    <div className="mx-auto w-full max-w-[1180px] px-3 pb-6 pt-3 sm:px-6 lg:px-10 lg:pt-8">
      <header className="mb-4 flex items-center gap-2 px-1 lg:mb-6">
        <div className="flex-1">
          <h1 className="display text-[28px] leading-tight text-ink lg:text-[32px]">Transactions</h1>
          <p className="text-[13px] text-ink-3">{mode === "review" ? "Give each one a bucket. Enter accepts the suggestion." : "Everything, newest first."}</p>
        </div>
        <div className="-mr-2 lg:hidden">
          <UserMenu />
        </div>
      </header>
      <TxList items={page.items} nextCursor={page.nextCursor} total={page.total} mode={mode} choices={choices} recentIds={recent} accounts={accounts} query={q ?? ""} />
    </div>
  );
}
