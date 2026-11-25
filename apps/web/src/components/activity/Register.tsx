"use client";
import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Clock, Lock, Repeat, Search } from "lucide-react";
import { categoryLabel } from "@/lib/category-icons";
import { cx } from "@/lib/cx";
import { formatDay } from "@/lib/format";
import type { CategoryOption, TransactionVM } from "@/lib/view-models";
import { loadMoreTransactionsAction, setClearedAction } from "@/server/actions/transactions";
import { CategoryIcon } from "@/components/icons/CategoryIcon";
import { ActionMenu } from "@/components/ui/ActionMenu";
import { Button } from "@/components/ui/Button";
import { Money } from "@/components/ui/Money";
import { useToast } from "@/components/ui/Toast";
import type { RegisterQuery } from "@/server/queries/transactions";
import { FlagMark } from "./FlagPicker";

/** YNAB's cleared column: green "C" when cleared, outlined "C" when not, a lock once reconciled. */
export function ClearedToggle({ cleared, onToggle }: { cleared: TransactionVM["cleared"]; onToggle?: () => void }) {
  const label = cleared === "reconciled" ? "Reconciled" : cleared === "cleared" ? "Cleared" : cleared === "pending" ? "Pending" : "Uncleared";
  return (
    <button
      type="button"
      aria-label={`${label}${cleared === "reconciled" || cleared === "pending" ? "" : ". Toggle cleared"}`}
      aria-pressed={cleared === "cleared" || cleared === "reconciled"}
      disabled={cleared === "reconciled" || cleared === "pending" || !onToggle}
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.();
      }}
      title={label}
      className="inline-flex h-9 w-9 items-center justify-center disabled:cursor-default"
    >
      <span
        className={cx(
          "inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border text-[10px] font-bold leading-none",
          cleared === "cleared" && "border-pos-bar bg-pos-bar text-white",
          cleared === "reconciled" && "border-pos-bar bg-pos-wash text-pos",
          cleared === "uncleared" && "border-rule-strong text-ink-3",
          cleared === "pending" && "border-transparent text-warn",
        )}
      >
        {cleared === "reconciled" ? <Lock size={10} strokeWidth={2.5} /> : cleared === "pending" ? <Clock size={14} strokeWidth={2} /> : "C"}
      </span>
    </button>
  );
}

/** Blue text buttons in the register toolbar (YNAB). */
export const TOOLBAR_BTN = "inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-[14px] font-semibold text-accent hover:bg-accent-soft";

export type RegisterFilter = "all" | "uncleared" | "unapproved";

export interface UpcomingRow {
  scheduledId: string;
  date: string;
  payee: string;
  categoryName: string | null;
  amount: bigint;
  accountName?: string;
}

/** The yellow "This needs a category" pill. */
export function NeedsCategory() {
  return (
    <span className="pill text-[12px] font-semibold" data-tone="warn" style={{ minHeight: 22 }}>
      This needs a category
    </span>
  );
}

/** "Group: icon Category" (YNAB), split / transfer labels, or the yellow pill when uncategorized. */
export function CategoryCell({ t, index, short }: { t: TransactionVM; index?: Map<string, CategoryOption>; short?: boolean }) {
  if (t.transferAccountName) return <span className="block truncate text-ink-3">Transfer · {t.transferAccountName}</span>;
  if (t.splits?.length) return <span className="text-ink-2">{t.categoryName ?? `Split (${t.splits.length})`}</span>;
  if (!t.categoryId || !t.categoryName) return t.amount === 0n ? <span className="text-ink-3">—</span> : <NeedsCategory />;
  const opt = index?.get(t.categoryId);
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-ink-2">
      {!short && opt?.groupName && opt.groupName !== "Inflow" && <span className="shrink-0 text-ink-3">{opt.groupName}:</span>}
      <CategoryIcon icon={opt?.icon} name={t.categoryName} size={15} />
      <span className="truncate text-ink">{categoryLabel(t.categoryName)}</span>
    </span>
  );
}

function Band({ title, count, open, onToggle, tone, children }: { title: string; count: number; open: boolean; onToggle: () => void; tone: "pending" | "scheduled"; children: ReactNode }) {
  return (
    <section aria-label={title} className="border-b border-rule">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={cx("flex min-h-10 w-full items-center gap-2 px-4 text-left text-[13.5px] font-bold lg:px-6", tone === "pending" ? "bg-warn-wash text-warn" : "bg-group text-ink")}
      >
        <ChevronDown size={16} strokeWidth={2.4} aria-hidden className={cx("transition-transform", !open && "-rotate-90")} />
        {title} <span className="num font-semibold opacity-70">({count})</span>
      </button>
      {open && children}
    </section>
  );
}

const TH = "eyebrow sticky top-0 z-[1] border-b border-rule bg-paper px-2 py-2.5 text-left font-semibold";
const TD = "border-b border-rule px-2 py-2 align-middle";

/**
 * All Accounts / account register (server-paged), YNAB columns: account · date · payee · category · memo ·
 * outflow · inflow · cleared (+ running balance on one account). Pending and scheduled rows sit in
 * collapsible bands above. Search and the View filter live in the URL (`?q=`, `?f=`). Phones get a list
 * grouped by day.
 */
export function Register({
  rows: firstRows,
  nextCursor: firstCursor,
  count,
  query,
  showAccount,
  showRunningBalance,
  onOpen,
  upcoming,
  onOpenUpcoming,
  categoryOptions = [],
  searchLabel = "Search transactions",
  toolbar,
}: {
  rows: TransactionVM[];
  nextCursor: string | null;
  count: number | null;
  query: RegisterQuery;
  showAccount?: boolean;
  showRunningBalance?: boolean;
  onOpen?: (tx: TransactionVM) => void;
  /** Scheduled occurrences in the next weeks, shown above the register (not in balances). */
  upcoming?: UpcomingRow[];
  onOpenUpcoming?: (scheduledId: string) => void;
  /** For "Group: Category" labels and icons. */
  categoryOptions?: CategoryOption[];
  searchLabel?: string;
  /** Left side of the toolbar (Add Transaction, File Import, Reconcile…). */
  toolbar?: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const [extra, setExtra] = useState<{ key: string; rows: TransactionVM[]; cursor: string | null }>({ key: "", rows: [], cursor: null });
  const [q, setQ] = useState(query.q ?? "");
  const [cleared, setCleared] = useState<Record<string, TransactionVM["cleared"]>>({});
  const [loading, startLoading] = useTransition();
  const [pendingOpen, setPendingOpen] = useState(true);
  const [schedOpen, setSchedOpen] = useState(false);
  const [, start] = useTransition();
  const pageKey = `${firstCursor}|${firstRows[0]?.id ?? ""}|${firstRows.length}|${JSON.stringify(query)}`;
  const more = extra.key === pageKey ? extra : { key: pageKey, rows: [], cursor: firstCursor };
  const filter: RegisterFilter = query.filter ?? "all";
  const index = useMemo(() => new Map(categoryOptions.map((o) => [o.id, o])), [categoryOptions]);

  function setParam(name: string, value: string | null) {
    const sp = new URLSearchParams(params.toString());
    if (value) sp.set(name, value);
    else sp.delete(name);
    router.replace(`${pathname}${sp.size ? `?${sp}` : ""}`, { scroll: false });
  }

  useEffect(() => {
    if ((query.q ?? "") === q) return;
    const t = setTimeout(() => setParam("q", q.trim() || null), 350);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = [...firstRows, ...more.rows].map((t) => ({ ...t, cleared: cleared[t.id] ?? t.cleared }));
  const pending = all.filter((t) => t.cleared === "pending");
  const rows = all.filter((t) => t.cleared !== "pending");

  const toggle = (t: TransactionVM) => {
    const next = t.cleared === "cleared" ? "uncleared" : "cleared";
    setCleared((s) => ({ ...s, [t.id]: next }));
    start(async () => {
      const r = await setClearedAction({ id: t.id, cleared: next });
      if (!r.ok) {
        setCleared((s) => ({ ...s, [t.id]: t.cleared }));
        toast.show({ message: r.error, tone: "error" });
      }
    });
  };

  const loadMore = () =>
    startLoading(async () => {
      if (!more.cursor) return;
      const r = await loadMoreTransactionsAction(query, more.cursor);
      setExtra({ key: pageKey, rows: [...more.rows, ...r.rows], cursor: r.nextCursor });
    });

  const VIEW_LABEL: Record<RegisterFilter, string> = { all: "All transactions", uncleared: "Uncleared", unapproved: "Needs approval" };

  const tableRow = (t: TransactionVM, muted?: boolean) => (
    <tr
      key={t.id}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen ? () => onOpen(t) : undefined}
      onKeyDown={(e) => {
        if (onOpen && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen(t);
        }
      }}
      className={cx("cursor-pointer text-[14px] hover:bg-paper-hover focus-visible:bg-accent-soft", muted && "text-ink-3")}
    >
      <td className={cx(TD, "w-8 pl-4 lg:pl-6")}>
        <span className="flex items-center gap-1">
          {!t.approved ? <span aria-label="Needs approval" title="Needs approval" className="inline-block h-2 w-2 rounded-full bg-accent" /> : <span className="inline-block w-2" />}
          {t.flag && <FlagMark flag={t.flag} />}
        </span>
      </td>
      {showAccount && <td className={cx(TD, "max-w-[170px] truncate text-ink-2")}>{t.accountName}</td>}
      <td className={cx(TD, "num whitespace-nowrap text-ink-2")}>{formatDay(t.date)}</td>
      <td className={cx(TD, "max-w-[220px] truncate font-medium text-ink")}>{t.payee}</td>
      <td className={cx(TD, "max-w-[260px]")}>
        <CategoryCell t={t} index={index} />
      </td>
      <td className={cx(TD, "max-w-[200px] truncate text-ink-3")}>{t.memo}</td>
      <td className={cx(TD, "num whitespace-nowrap text-right")}>{t.amount < 0n ? <Money value={-t.amount} /> : null}</td>
      <td className={cx(TD, "num whitespace-nowrap text-right")}>{t.amount > 0n ? <Money value={t.amount} tone="pos" /> : null}</td>
      {showRunningBalance && <td className={cx(TD, "num whitespace-nowrap text-right text-ink-2")}>{t.runningBalance !== undefined ? <Money value={t.runningBalance} tone={t.runningBalance < 0n ? "neg" : "inherit"} /> : null}</td>}
      <td className={cx(TD, "w-12 pr-4 text-center lg:pr-6")}>
        <ClearedToggle cleared={t.cleared} onToggle={() => toggle(t)} />
      </td>
    </tr>
  );

  const head = (
    <thead>
      <tr>
        <th scope="col" className={cx(TH, "w-8 pl-4 lg:pl-6")}>
          <span className="sr-only">Status</span>
        </th>
        {showAccount && <th scope="col" className={TH}>Account</th>}
        <th scope="col" className={cx(TH, "w-[84px]")}>Date</th>
        <th scope="col" className={TH}>Payee</th>
        <th scope="col" className={TH}>Category</th>
        <th scope="col" className={TH}>Memo</th>
        <th scope="col" className={cx(TH, "w-[110px] text-right")}>Outflow</th>
        <th scope="col" className={cx(TH, "w-[110px] text-right")}>Inflow</th>
        {showRunningBalance && <th scope="col" className={cx(TH, "w-[120px] text-right")}>Balance</th>}
        <th scope="col" className={cx(TH, "w-12 pr-4 text-center lg:pr-6")}>
          <span aria-label="Cleared">C</span>
        </th>
      </tr>
    </thead>
  );

  const byDate = rows.reduce<Record<string, TransactionVM[]>>((acc, t) => {
    (acc[t.date] ??= []).push(t);
    return acc;
  }, {});

  const phoneRow = (t: TransactionVM) => (
    <li key={t.id} className="flex items-center gap-1 border-b border-rule pl-2 pr-4">
      <ClearedToggle cleared={t.cleared} onToggle={() => toggle(t)} />
      <button type="button" onClick={() => onOpen?.(t)} className="flex min-h-[60px] min-w-0 flex-1 items-center gap-3 py-2 text-left">
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 truncate text-[15px] font-semibold text-ink">
            {!t.approved && <span aria-label="Needs approval" className="inline-block h-2 w-2 shrink-0 rounded-full bg-accent" />}
            <span className="truncate">{t.payee}</span>
            {t.flag && <FlagMark flag={t.flag} />}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-[12.5px] text-ink-3">
            <CategoryCell t={t} index={index} short />
            {showAccount && <span className="shrink-0 truncate"> · {t.accountName}</span>}
          </span>
        </span>
        <span className="text-right">
          <Money value={t.amount} tone={t.amount > 0n ? "pos" : "ink"} className="block text-[15px] font-semibold" />
          {showRunningBalance && t.runningBalance !== undefined && <Money value={t.runningBalance} className="block text-[11px] text-ink-3" />}
        </span>
      </button>
    </li>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-rule px-4 py-2.5 lg:px-6">
        {toolbar}
        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
          <ActionMenu
            label="View"
            align="end"
            trigger={
              <span className="inline-flex items-center gap-1">
                View{filter !== "all" ? `: ${VIEW_LABEL[filter]}` : ""} <ChevronDown size={15} strokeWidth={2.4} aria-hidden />
              </span>
            }
            triggerClassName="inline-flex min-h-9 items-center rounded-md px-2.5 text-[14px] font-semibold text-accent hover:bg-accent-soft"
            items={(["all", "uncleared", "unapproved"] as const).map((f) => ({ id: f, label: `${filter === f ? "✓ " : ""}${VIEW_LABEL[f]}`, onSelect: () => setParam("f", f === "all" ? null : f) }))}
          />
          <label className="relative block min-w-0 flex-1 sm:w-64 sm:flex-none">
            <span className="sr-only">{searchLabel}</span>
            <Search size={16} strokeWidth={2} aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={searchLabel}
              className="h-9 w-full rounded-lg border border-rule-strong bg-paper-raised pl-9 pr-3 text-[14px] outline-none placeholder:text-ink-3 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
            />
          </label>
        </div>
      </div>
      {count !== null && (
        <p className="num px-4 pt-2 text-[12px] text-ink-3 lg:px-6">
          {count.toLocaleString("en-US")} transactions{filter !== "all" ? ` · ${VIEW_LABEL[filter]}` : ""}
        </p>
      )}

      {upcoming && upcoming.length > 0 && (
        <Band title="Scheduled Transactions" count={upcoming.length} open={schedOpen} onToggle={() => setSchedOpen((v) => !v)} tone="scheduled">
          <ul>
            {upcoming.map((u) => (
              <li key={`${u.scheduledId}:${u.date}`} className="border-b border-dashed border-rule last:border-b-0">
                <button type="button" onClick={() => onOpenUpcoming?.(u.scheduledId)} className="flex min-h-[44px] w-full items-center gap-3 px-4 py-1.5 text-left text-ink-3 hover:bg-paper-hover lg:px-6">
                  <Repeat size={14} strokeWidth={2} aria-hidden className="shrink-0" />
                  <span className="num w-[56px] shrink-0 text-[13px]">{formatDay(u.date)}</span>
                  <span className="min-w-0 flex-1 truncate text-[14px]">
                    <span className="text-ink-2">{u.payee}</span>
                    {u.categoryName && <span> · {categoryLabel(u.categoryName)}</span>}
                    {u.accountName && <span> · {u.accountName}</span>}
                  </span>
                  <Money value={u.amount} tone="muted" className="text-[14px]" />
                </button>
              </li>
            ))}
          </ul>
        </Band>
      )}

      {pending.length > 0 && (
        <div className="lg:hidden">
          <Band title="Pending Transactions" count={pending.length} open={pendingOpen} onToggle={() => setPendingOpen((v) => !v)} tone="pending">
            <ul>{pending.map(phoneRow)}</ul>
          </Band>
        </div>
      )}

      <div className="hidden lg:block">
        <table className="w-full border-collapse">
          <caption className="sr-only">Transactions</caption>
          {head}
          {pending.length > 0 && (
            <tbody aria-label="Pending transactions">
              <tr>
                <td colSpan={10} className="p-0">
                  <button
                    type="button"
                    aria-expanded={pendingOpen}
                    onClick={() => setPendingOpen((v) => !v)}
                    className="flex min-h-10 w-full items-center gap-2 border-b border-rule bg-warn-wash px-6 text-left text-[13.5px] font-bold text-warn"
                  >
                    <ChevronDown size={16} strokeWidth={2.4} aria-hidden className={cx("transition-transform", !pendingOpen && "-rotate-90")} />
                    Pending Transactions <span className="num font-semibold opacity-70">({pending.length})</span>
                  </button>
                </td>
              </tr>
              {pendingOpen && pending.map((t) => tableRow(t, true))}
            </tbody>
          )}
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="py-10 text-center text-[14px] text-ink-3">
                  No transactions match.
                </td>
              </tr>
            )}
            {rows.map((t) => tableRow(t))}
          </tbody>
        </table>
      </div>

      <div className="lg:hidden">
        {rows.length === 0 && <p className="py-8 text-center text-[14px] text-ink-3">No transactions match.</p>}
        {Object.entries(byDate).map(([date, txs]) => (
          <section key={date} aria-label={formatDay(date, { weekday: true })}>
            <h4 className="sticky top-0 z-[1] border-b border-rule bg-paper-sunken px-4 py-1.5 text-[12px] font-bold uppercase tracking-[0.05em] text-ink-3">{formatDay(date, { weekday: true })}</h4>
            <ul>{txs.map(phoneRow)}</ul>
          </section>
        ))}
      </div>
      {more.cursor && (
        <div className="mt-4 flex justify-center pb-6">
          <Button variant="secondary" onClick={loadMore} busy={loading}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
