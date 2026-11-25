import { monthOf, today as localToday } from "@homebase/shared";
import { isAdmin, requireUser } from "@/server/auth";
import { loadCategoryOptions, loadRecentCategoryIds } from "@/server/queries/plan";
import { loadAccountInbox, loadEntities } from "@/server/queries/inbox";
import { loadPayeeOptions, loadScheduled } from "@/server/queries/scheduled";
import { loadSyncStatus } from "@/server/queries/sync";
import { loadTransferSuggestions } from "@/server/queries/transfers";
import { loadAccounts, loadInbox, loadRegister, parseRegisterParams } from "@/server/queries/transactions";
import { ActivityView } from "./ActivityView";

export const metadata = { title: "All Accounts" };

/** Accepts the Reports drill-down params: `?category=<id,…>&payee=&from=&to=&account=` plus `q` and `f`. */
export default async function ActivityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const cu = await requireUser();
  const query = parseRegisterParams(await searchParams);
  const today = localToday();
  const admin = isAdmin(cu);
  const inbox = await loadInbox();
  const { accounts } = await loadAccounts(today);
  const register = await loadRegister(query);
  const options = await loadCategoryOptions(monthOf(today), today);
  const recent = await loadRecentCategoryIds(cu.user.id);
  const sync = await loadSyncStatus();
  const transferSuggestions = await loadTransferSuggestions();
  const scheduled = await loadScheduled(today);
  const payees = await loadPayeeOptions();
  const newAccounts = admin ? await loadAccountInbox() : [];
  const entities = admin && newAccounts.length ? await loadEntities() : [];
  return (
    <ActivityView
      inbox={inbox}
      accounts={accounts}
      register={register}
      query={query}
      categoryOptions={options}
      recentCategoryIds={recent}
      sync={sync}
      newAccounts={newAccounts}
      entities={entities}
      transferSuggestions={transferSuggestions}
      scheduled={scheduled}
      payees={payees}
    />
  );
}
