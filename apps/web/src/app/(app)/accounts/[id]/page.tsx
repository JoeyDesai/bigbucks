import { notFound } from "next/navigation";
import { today as localToday } from "@homebase/shared";
import { requireUser } from "@/server/auth";
import { loadAccounts } from "@/server/queries/transactions";
import { loadAccountHistory, loadCategoryChoices, loadRecentChoiceIds, loadTxPage } from "@/server/queries/glow";
import { AccountHeader } from "./AccountHeader";
import { BalanceChart } from "@/components/glow/BalanceChart";
import { TxList } from "@/components/glow/TxList";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  if (!UUID.test(id)) return { title: "Account" };
  const { accounts } = await loadAccounts(localToday(), { includeClosed: true });
  return { title: accounts.find((a) => a.id === id)?.name ?? "Account" };
}

/** One account: balance and its change, a daily balance chart, then its transactions (the same fast list). */
export default async function AccountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ view?: string; q?: string }> }) {
  const cu = await requireUser();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const sp = await searchParams;
  const today = localToday();
  const { accounts } = await loadAccounts(today, { includeClosed: true });
  const account = accounts.find((a) => a.id === id);
  if (!account) notFound();
  const mode = sp.view === "review" ? "review" : "all";
  const q = sp.q?.slice(0, 200) || undefined;
  const [history, choices] = [await loadAccountHistory(id, today), await loadCategoryChoices()];
  const page = await loadTxPage({ mode, accountId: id, q }, choices);
  const recent = await loadRecentChoiceIds(cu.user.id);
  return (
    <div className="mx-auto w-full max-w-[1180px] px-3 pb-6 pt-3 sm:px-6 lg:px-10 lg:pt-8">
      <AccountHeader account={account} />
      <div className="hb-rise space-y-6">
        <BalanceChart points={history} title={`${account.name} balance`} />
        <section aria-label={`${account.name} transactions`}>
          <h2 className="eyebrow mb-3 px-1">Transactions</h2>
          <TxList items={page.items} nextCursor={page.nextCursor} total={page.total} mode={mode} accountId={id} choices={choices} recentIds={recent} accounts={accounts} hideAccount query={q ?? ""} />
        </section>
      </div>
    </div>
  );
}
