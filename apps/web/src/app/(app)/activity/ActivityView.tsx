"use client";
import { useEffect, useOptimistic, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCheck, FileUp, Inbox, Info, Plus, Repeat, X } from "lucide-react";
import { formatMilli } from "@homebase/shared";
import { BRAND } from "@/lib/brand";
import { categoryLabel } from "@/lib/category-icons";
import type { AccountVM, CategoryOption, TransactionVM } from "@/lib/view-models";
import type { InboxEntryVM } from "@/server/queries/inbox";
import type { SyncStatus } from "@/server/queries/sync";
import { approveAction, approveAllHighConfidenceAction, markTransferAction, recategorizeAction, restoreTransactionsAction, unapproveAction } from "@/server/actions/transactions";
import type { PayeeOption, ScheduledVM } from "@/server/queries/scheduled";
import type { RegisterQuery } from "@/server/queries/transactions";
import type { TransferSuggestionVM } from "@/server/queries/transfers";
import { AccountSections } from "@/components/activity/AccountSections";
import { BalanceStrip } from "@/components/activity/BalanceStrip";
import { DrillDownBanner } from "@/components/activity/DrillDownBanner";
import { ScheduledSheet } from "@/components/activity/ScheduledSheet";
import { AccountInbox } from "@/components/activity/AccountInbox";
import { CategoryPicker } from "@/components/activity/CategoryPicker";
import { Register, TOOLBAR_BTN, type UpcomingRow } from "@/components/activity/Register";
import { SyncNowButton } from "@/components/activity/SyncNowButton";
import { TransactionCard } from "@/components/activity/TransactionCard";
import { TransactionSheet } from "@/components/activity/TransactionSheet";
import { PageHeader } from "@/components/shell/PageHeader";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PullToRefresh } from "@/components/ui/PullToRefresh";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";

export interface ActivityViewProps {
  inbox: { count: number; items: TransactionVM[] };
  accounts: AccountVM[];
  register: { rows: TransactionVM[]; nextCursor: string | null; count: number | null };
  query: RegisterQuery;
  categoryOptions: CategoryOption[];
  recentCategoryIds: string[];
  sync: SyncStatus;
  newAccounts: InboxEntryVM[];
  entities: { id: string; name: string }[];
  transferSuggestions: Record<string, TransferSuggestionVM>;
  scheduled: ScheduledVM[];
  payees: PayeeOption[];
}

const HIGH = 0.9;

/** All Accounts (YNAB register) with the review inbox behind the "N new transactions" banner. */
export function ActivityView({ inbox, accounts, register, query, categoryOptions, recentCategoryIds, sync, newAccounts, entities, transferSuggestions, scheduled, payees }: ActivityViewProps) {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const [, start] = useTransition();
  const [hidden, hide] = useOptimistic<string[], string[]>([], (s, ids) => [...s, ...ids]);
  const [picking, setPicking] = useState<TransactionVM | null>(null);
  const [editing, setEditing] = useState<{ tx: TransactionVM | null } | null>(null);
  const [sched, setSched] = useState<{ item: ScheduledVM | null } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(params.get("review") === "1");
  const queue = inbox.items.filter((t) => !hidden.includes(t.id));
  const high = queue.filter((t) => (t.suggestion?.confidence ?? 0) >= HIGH);
  const toReview = Math.max(inbox.count - hidden.length, 0);

  // The phone tab bar's center "+" lands here with ?new=1: open the editor, then drop the param.
  useEffect(() => {
    if (params.get("new") !== "1") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot deep link
    setEditing({ tx: null });
    router.replace("/activity", { scroll: false });
  }, [params, router]);

  const budget = accounts.filter((a) => a.onBudget && !a.closed);
  const totals = {
    cleared: budget.reduce((s, a) => s + (a.clearedBalance ?? 0n), 0n),
    uncleared: budget.reduce((s, a) => s + (a.unclearedBalance ?? 0n), 0n),
    working: budget.reduce((s, a) => s + a.balance, 0n),
  };
  const upcoming: UpcomingRow[] = scheduled
    .flatMap((s) =>
      s.upcoming.map((date) => ({
        scheduledId: s.id,
        date,
        payee: s.payeeName ?? (s.transferAccountId ? "Transfer" : "Scheduled"),
        categoryName: s.splits.length ? "Split" : s.categoryName,
        amount: s.amount,
        accountName: s.accountName,
      })),
    )
    .sort((a, b) => a.date.localeCompare(b.date));

  const fail = (error: string): void => {
    toast.show({ message: error, tone: "error" });
  };
  const undoable = (message: string, undo: () => Promise<{ ok: boolean; error?: string } | { ok: false; error: string }>) =>
    toast.show({
      message,
      action: {
        label: "Undo",
        onAction: () =>
          start(async () => {
            const r = await undo();
            if (!r.ok) fail("error" in r && r.error ? r.error : "Couldn't undo.");
          }),
      },
    });

  const approve = (tx: TransactionVM) =>
    start(async () => {
      hide([tx.id]);
      const needsCategory = !tx.categoryId && tx.suggestion;
      if (needsCategory) {
        const r = await recategorizeAction({ ids: [tx.id], categoryId: tx.suggestion!.categoryId, approve: true });
        if (!r.ok) return fail(r.error);
        undoable(`Approved ${tx.payee} · ${categoryLabel(tx.suggestion!.categoryName)}`, () => restoreTransactionsAction([{ id: tx.id, categoryId: tx.categoryId, approved: false }]));
      } else {
        const r = await approveAction([tx.id]);
        if (!r.ok) return fail(r.error);
        undoable(`Approved ${tx.payee}${tx.categoryName ? ` · ${categoryLabel(tx.categoryName)}` : ""}`, () => unapproveAction([tx.id]));
      }
    });

  const recategorize = (tx: TransactionVM, o: CategoryOption) =>
    start(async () => {
      hide([tx.id]);
      const r = await recategorizeAction({ ids: [tx.id], categoryId: o.id, approve: true });
      if (!r.ok) return fail(r.error);
      if (r.skipped.length) return fail(r.skipped[0]!.reason);
      undoable(`${tx.payee} → ${categoryLabel(o.name)}`, () => restoreTransactionsAction([{ id: tx.id, categoryId: tx.categoryId, approved: tx.approved }]));
    });

  const linkTransfer = (tx: TransactionVM) =>
    start(async () => {
      const t = transferSuggestions[tx.id];
      if (!t) return;
      hide([tx.id]);
      const r = await markTransferAction({ id: tx.id, accountId: t.accountId, pairWithId: t.pairWithId });
      if (!r.ok) return fail(r.error);
      toast.show({ message: `Linked ${tx.payee} as a transfer with ${t.accountName}` });
    });

  const approveAll = () =>
    start(async () => {
      hide(high.map((t) => t.id));
      const r = await approveAllHighConfidenceAction();
      if (!r.ok) return fail(r.error);
      if (!r.approved.length) return void toast.show({ message: "Nothing was sure enough to approve automatically." });
      undoable(`Approved ${r.approved.length} high-confidence ${r.approved.length === 1 ? "transaction" : "transactions"}`, () => unapproveAction(r.approved));
    });

  const review = (
    <section aria-labelledby="review-h" className="border-b border-rule bg-paper-sunken px-4 py-4 lg:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
        <div>
          <h2 id="review-h" className="text-[17px] font-bold text-ink">
            Approve and categorize <span className="num ml-1 text-ink-3">{toReview}</span>
          </h2>
          {queue.length > 0 && <p className="text-[12.5px] text-ink-3">Swipe right to approve, left to change the category. Tap a suggestion to see why.</p>}
        </div>
        <div className="flex items-center gap-2">
          {high.length > 0 && (
            <Button variant="positive" size="sm" icon={<CheckCheck size={15} strokeWidth={2.2} />} onClick={approveAll}>
              Approve {high.length} sure {high.length === 1 ? "one" : "ones"}
            </Button>
          )}
          <IconButton label="Close review" onClick={() => setReviewOpen(false)}>
            <X size={18} strokeWidth={2} />
          </IconButton>
        </div>
      </div>
      {queue.length === 0 ? (
        <EmptyState icon={<Inbox size={22} strokeWidth={2} />} title="All caught up" className="py-6">
          New transactions show up here after each sync. Anything {BRAND.name} is sure about is approved for you.
        </EmptyState>
      ) : (
        <div className="card overflow-hidden">
          {queue.map((tx) => (
            <TransactionCard
              key={tx.id}
              tx={tx}
              onApprove={approve}
              onChangeCategory={setPicking}
              onSplit={(t) => setEditing({ tx: t })}
              onMarkTransfer={(t) => setEditing({ tx: t })}
              transferSuggestion={transferSuggestions[tx.id]}
              onLinkTransfer={linkTransfer}
            />
          ))}
        </div>
      )}
      {inbox.count > inbox.items.length && (
        <p className="mt-2 text-[12px] text-ink-3">
          Showing the newest {inbox.items.length} of {inbox.count}. Approve these to see more.
        </p>
      )}
    </section>
  );

  const toolbar = (
    <>
      <button type="button" className={TOOLBAR_BTN} onClick={() => setEditing({ tx: null })}>
        <Plus size={16} strokeWidth={2.4} aria-hidden /> Add Transaction
      </button>
      <Link href="/settings/imports" className={`${TOOLBAR_BTN} hidden sm:inline-flex`}>
        <FileUp size={16} strokeWidth={2.2} aria-hidden /> File Import
      </Link>
      <button type="button" className={`${TOOLBAR_BTN} hidden sm:inline-flex`} onClick={() => setSched({ item: null })}>
        <Repeat size={15} strokeWidth={2.2} aria-hidden /> Schedule
      </button>
    </>
  );

  return (
    <PullToRefresh onRefresh={() => router.refresh()}>
      {toReview > 0 && !reviewOpen && (
        <div className="flex items-center gap-2 bg-accent-soft px-4 py-2 text-[14px] text-ink lg:px-6">
          <Info size={17} strokeWidth={2.2} aria-hidden className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="num font-bold">{toReview}</span> new {toReview === 1 ? "transaction" : "transactions"} to approve or categorize.
          </span>
          <Button size="sm" variant="primary" onClick={() => setReviewOpen(true)} aria-label="View transactions to approve">
            View
          </Button>
        </div>
      )}

      <PageHeader
        title={
          <>
            <span className="lg:hidden">Accounts</span>
            <span className="hidden lg:inline">All Accounts</span>
          </>
        }
        actions={
          <>
            <SyncNowButton status={sync} />
            <IconButton label="Add transaction" onClick={() => setEditing({ tx: null })} className="lg:hidden">
              <Plus size={22} strokeWidth={2} />
            </IconButton>
          </>
        }
        className="lg:pb-2"
      />

      <div className="px-4 pb-4 lg:px-6">
        <BalanceStrip cleared={totals.cleared} uncleared={totals.uncleared} working={totals.working} />
      </div>

      {newAccounts.length > 0 && (
        <div className="px-4 lg:px-6">
          <AccountInbox entries={newAccounts} accounts={accounts} entities={entities} />
        </div>
      )}

      <div className="px-4 pb-5 lg:hidden">
        <AccountSections accounts={accounts} />
      </div>

      {reviewOpen && review}

      <section aria-labelledby="register-h" className="min-w-0 border-t border-rule lg:border-t-0">
        <h2 id="register-h" className="sr-only">
          {query.accountId ? (accounts.find((a) => a.id === query.accountId)?.name ?? "Account") : "All transactions"}
        </h2>
        <div className="px-4 pt-3 lg:px-6 lg:pt-0">
          <DrillDownBanner query={query} categoryOptions={categoryOptions} payees={payees} accounts={accounts} />
        </div>
        <Register
          rows={register.rows}
          nextCursor={register.nextCursor}
          count={register.count}
          query={query}
          showAccount
          onOpen={(t) => setEditing({ tx: t })}
          upcoming={upcoming}
          onOpenUpcoming={(id) => setSched({ item: scheduled.find((s) => s.id === id) ?? null })}
          categoryOptions={categoryOptions}
          searchLabel="Search All Accounts"
          toolbar={toolbar}
        />
      </section>

      <Sheet open={!!picking} onClose={() => setPicking(null)} title={picking ? `Categorize ${picking.payee}` : ""} description={picking ? formatMilli(picking.amount) : undefined} tall>
        {picking && (
          <CategoryPicker
            autoFocus
            options={categoryOptions}
            recentIds={recentCategoryIds}
            value={picking.categoryId ?? picking.suggestion?.categoryId}
            onSelect={(o) => {
              const tx = picking;
              setPicking(null);
              recategorize(tx, o);
            }}
          />
        )}
      </Sheet>

      <ScheduledSheet
        open={!!sched}
        onClose={() => setSched(null)}
        item={sched?.item ?? null}
        accounts={accounts}
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
        categoryOptions={categoryOptions}
        recentCategoryIds={recentCategoryIds}
        onError={fail}
        onSaved={(message, undo) =>
          undo
            ? undoable(message, async () => {
                await undo();
                return { ok: true };
              })
            : toast.show({ message })
        }
      />
    </PullToRefresh>
  );
}
