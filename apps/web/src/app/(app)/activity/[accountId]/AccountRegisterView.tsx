"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Repeat, ShieldCheck } from "lucide-react";
import { formatDay, timeAgo } from "@/lib/format";
import type { AccountVM, CategoryOption, TransactionVM } from "@/lib/view-models";
import { BalanceStrip } from "@/components/activity/BalanceStrip";
import { DrillDownBanner } from "@/components/activity/DrillDownBanner";
import { Register, TOOLBAR_BTN } from "@/components/activity/Register";
import { ScheduledSheet } from "@/components/activity/ScheduledSheet";
import type { PayeeOption, ScheduledVM } from "@/server/queries/scheduled";
import type { RegisterQuery } from "@/server/queries/transactions";
import { ReconcileSheet } from "@/components/activity/ReconcileSheet";
import { TransactionSheet } from "@/components/activity/TransactionSheet";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button, IconButton } from "@/components/ui/Button";
import { PullToRefresh } from "@/components/ui/PullToRefresh";
import { StatusDot } from "@/components/ui/StatusDot";
import { useToast } from "@/components/ui/Toast";

export interface AccountRegisterViewProps {
  account: AccountVM;
  summary: { cleared: bigint; uncleared: bigint; working: bigint; pending: bigint };
  lastReconciled: { at: string; balance: bigint } | null;
  accounts: AccountVM[];
  register: { rows: TransactionVM[]; nextCursor: string | null; count: number | null };
  query: RegisterQuery;
  categoryOptions: CategoryOption[];
  recentCategoryIds: string[];
  scheduled: ScheduledVM[];
  payees: PayeeOption[];
}

/** One account (YNAB): name, balance strip, Reconcile, and its register with running balance. */
export function AccountRegisterView({ account, summary, lastReconciled, accounts, register, query, categoryOptions, recentCategoryIds, scheduled, payees }: AccountRegisterViewProps) {
  const router = useRouter();
  const toast = useToast();
  const [reconciling, setReconciling] = useState(false);
  const [editing, setEditing] = useState<{ tx: TransactionVM | null } | null>(null);
  const [sched, setSched] = useState<{ item: ScheduledVM | null } | null>(null);
  // Occurrences in the next 35 days, signed from this account's point of view.
  const upcoming = scheduled
    .flatMap((s) =>
      s.upcoming.map((date) => ({
        scheduledId: s.id,
        date,
        payee: s.payeeName ?? (s.transferAccountId ? "Transfer" : "Scheduled"),
        categoryName: s.splits.length ? "Split" : s.categoryName,
        amount: s.accountId === account.id ? s.amount : -s.amount,
      })),
    )
    .sort((a, b) => a.date.localeCompare(b.date));
  const fail = (m: string) => {
    toast.show({ message: m, tone: "error" });
  };
  return (
    <PullToRefresh onRefresh={() => router.refresh()}>
      <PageHeader
        title={account.name}
        eyebrow={
          <span className="inline-flex flex-wrap items-center gap-x-2">
            {account.institution}
            <StatusDot status={account.status} showLabel />
            {account.updatedAt && <span>· updated {timeAgo(account.updatedAt)}</span>}
          </span>
        }
        className="lg:pt-2"
        actions={
          <IconButton label="Add transaction" onClick={() => setEditing({ tx: null })} className="lg:hidden">
            <Plus size={22} strokeWidth={2} />
          </IconButton>
        }
      />
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3 px-4 pb-4 lg:px-6">
        <BalanceStrip cleared={summary.cleared} uncleared={summary.uncleared} working={summary.working} />
        <div className="ml-auto flex items-center gap-3">
          {lastReconciled && <span className="text-[12.5px] text-ink-3">Last reconciled {formatDay(lastReconciled.at.slice(0, 10), { withYear: true })}</span>}
          <Button variant="secondary" size="sm" icon={<ShieldCheck size={15} strokeWidth={2} />} onClick={() => setReconciling(true)}>
            Reconcile
          </Button>
        </div>
      </div>
      {(account.status === "needs_attention" || account.status === "error") && account.statusNote && (
        <p className="mx-4 mb-3 rounded-lg bg-warn-wash px-3 py-2 text-[13px] text-warn lg:mx-6">{account.statusNote}</p>
      )}
      <div className="border-t border-rule">
        <div className="px-4 pt-3 lg:px-6">
          <DrillDownBanner query={query} categoryOptions={categoryOptions} payees={payees} accounts={accounts} />
        </div>
        <Register
          rows={register.rows}
          nextCursor={register.nextCursor}
          count={register.count}
          query={query}
          showRunningBalance
          onOpen={(t) => setEditing({ tx: t })}
          upcoming={upcoming}
          onOpenUpcoming={(id) => setSched({ item: scheduled.find((s) => s.id === id) ?? null })}
          categoryOptions={categoryOptions}
          searchLabel={`Search ${account.name}`}
          toolbar={
            <>
              <button type="button" className={TOOLBAR_BTN} onClick={() => setEditing({ tx: null })}>
                <Plus size={16} strokeWidth={2.4} aria-hidden /> Add Transaction
              </button>
              <button type="button" className={`${TOOLBAR_BTN} hidden sm:inline-flex`} onClick={() => setSched({ item: null })}>
                <Repeat size={15} strokeWidth={2.2} aria-hidden /> Schedule
              </button>
            </>
          }
        />
      </div>
      <ReconcileSheet
        open={reconciling}
        onClose={() => setReconciling(false)}
        accountId={account.id}
        accountName={account.name}
        clearedBalance={summary.cleared}
        onDone={(m) => toast.show({ message: m })}
        onError={fail}
      />
      <ScheduledSheet
        open={!!sched}
        onClose={() => setSched(null)}
        item={sched?.item ?? null}
        accounts={accounts}
        defaultAccountId={account.id}
        categoryOptions={categoryOptions}
        recentCategoryIds={recentCategoryIds}
        payees={payees}
        onSaved={(m) => toast.show({ message: m })}
        onError={fail}
      />
      <TransactionSheet
        payees={payees}
        open={!!editing}
        onClose={() => setEditing(null)}
        tx={editing?.tx ?? null}
        accounts={accounts}
        defaultAccountId={account.id}
        categoryOptions={categoryOptions}
        recentCategoryIds={recentCategoryIds}
        onError={fail}
        onSaved={(message, undo) =>
          toast.show({
            message,
            action: undo ? { label: "Undo", onAction: () => void undo() } : undefined,
          })
        }
      />
    </PullToRefresh>
  );
}
