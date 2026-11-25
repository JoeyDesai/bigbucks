"use client";
import { useEffect, useMemo, useOptimistic, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChartPie, ChevronDown, CircleAlert, EyeOff, History, ListCollapse, ListTree, Plus, Redo2, Rows3, TriangleAlert, Undo2 } from "lucide-react";
import { formatMilli, type Month } from "@homebase/shared";
import { matchesFilter, planReducer, type PlanAction, type PlanFilter, type PlanState } from "@/lib/plan-state";
import { categoryLabel } from "@/lib/category-icons";
import { cx } from "@/lib/cx";
import { monthParam } from "@/lib/format";
import { useIsDesktop } from "@/lib/use-media";
import type { CategoryOption, CategoryVM, MonthSummaryVM } from "@/lib/view-models";
import type { PlanData } from "@/server/queries/plan";
import { assignAction, autoAssignAction, moveMoneyAction, redoAction, setCategoryHiddenAction, setMonthNoteAction, undoAction } from "@/server/actions/budget";
import { createCategoryAction, createGroupAction } from "@/server/settings/actions/household";
import type { ScheduledVM } from "@/server/queries/scheduled";
import { RecentMoves } from "@/components/budget/RecentMoves";
import { BudgetColumnHeader, GroupHeader } from "@/components/budget/GroupHeader";
import { BUDGET_GRID } from "@/components/budget/columns";
import { CategoryRow } from "@/components/budget/CategoryRow";
import { CategoryDetail } from "@/components/budget/CategoryDetail";
import { CategorySheet } from "@/components/budget/CategorySheet";
import { MonthNote } from "@/components/budget/MonthNote";
import { AgeOfMoneyTip, MonthInspector, MonthSummary, CostToBeMe } from "@/components/budget/MonthSummary";
import { MonthSwitcher } from "@/components/budget/MonthSwitcher";
import { RTABanner, RTA_BUTTON } from "@/components/budget/RTABanner";
import { MoneyPill } from "@/components/budget/AvailablePill";
import { AUTO_ASSIGN_ITEMS, AUTO_ASSIGN_OPTIONS } from "@/components/budget/auto-assign";
import { Avatar } from "@/components/shell/Avatar";
import { ActionMenu } from "@/components/ui/ActionMenu";
import { IconButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Money } from "@/components/ui/Money";
import { NamePopover } from "@/components/ui/NamePopover";
import { PullToRefresh } from "@/components/ui/PullToRefresh";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";

export interface PlanViewProps {
  month: Month;
  /** The real current month (for "Today"). */
  today: Month;
  plan: PlanData;
  categoryOptions: CategoryOption[];
  recentCategoryIds: string[];
  scheduled: ScheduledVM[];
  /** False on a fresh install: shows the first-run checklist. */
  hasBudgetAccounts?: boolean;
  admin?: boolean;
}

const FILTERS: { value: PlanFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "overspent", label: "Overspent" },
  { value: "underfunded", label: "Underfunded" },
  { value: "overfunded", label: "Overfunded" },
  { value: "available", label: "Money Available" },
  { value: "snoozed", label: "Snoozed" },
];

const TOOL = "inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-[14px] font-semibold text-accent hover:bg-accent-soft disabled:opacity-40 disabled:hover:bg-transparent";
const DENSITY_KEY = "hb_plan_density";

export function PlanView({ month, today, plan, categoryOptions, recentCategoryIds, scheduled, hasBudgetAccounts = true, admin }: PlanViewProps) {
  const router = useRouter();
  const toast = useToast();
  const isDesktop = useIsDesktop();
  const [, startTransition] = useTransition();
  const base: PlanState = useMemo(() => ({ groups: plan.groups, readyToAssign: plan.summary.readyToAssign }), [plan]);
  const [state, addOptimistic] = useOptimistic(base, planReducer);
  const [filter, setFilter] = useState<PlanFilter>("all");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [movesOpen, setMovesOpen] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [movesPending, startMoves] = useTransition();
  const hiddenRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- per-device preference read after hydration
      setCompact(localStorage.getItem(DENSITY_KEY) === "compact");
    } catch {
      /* private mode */
    }
  }, []);
  const toggleDensity = () => {
    setCompact((v) => {
      try {
        localStorage.setItem(DENSITY_KEY, v ? "comfortable" : "compact");
      } catch {
        /* ignore */
      }
      return !v;
    });
  };

  // Escape clears the desktop selection (sheets handle their own Escape).
  useEffect(() => {
    if (!openId || !isDesktop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const el = document.activeElement as HTMLElement | null;
      if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA") return;
      setOpenId(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openId, isDesktop]);

  useEffect(() => {
    if (!hiddenOpen) return;
    const onDown = (e: PointerEvent) => !hiddenRef.current?.contains(e.target as Node) && setHiddenOpen(false);
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [hiddenOpen]);

  const undoMove = (id: string) =>
    startMoves(async () => {
      const r = await undoAction(id);
      toast.show(r.ok ? { message: "Undone" } : { message: r.error, tone: "error" });
    });
  const redoMove = (id: string) =>
    startMoves(async () => {
      const r = await redoAction(id);
      toast.show(r.ok ? { message: "Redone" } : { message: r.error, tone: "error" });
    });
  const lastUndoable = plan.recentMoves.find((m) => m.canUndo && !m.undone);
  const lastRedoable = plan.recentMoves.find((m) => m.canRedo && m.undone);

  const undoToast = (message: string, operationId: string | null) =>
    toast.show({
      message,
      action: operationId
        ? {
            label: "Undo",
            onAction: () =>
              startTransition(async () => {
                const r = await undoAction(operationId);
                toast.show(r.ok ? { message: "Undone" } : { message: r.error, tone: "error" });
              }),
          }
        : undefined,
    });

  const setHidden = (categoryId: string, hidden: boolean, name: string) =>
    startTransition(async () => {
      const r = await setCategoryHiddenAction({ categoryId, hidden });
      if (!r.ok) toast.show({ message: r.error, tone: "error" });
      else undoToast(hidden ? `Hid ${categoryLabel(name)}` : `${categoryLabel(name)} is visible again`, r.operationId);
    });

  const counts = useMemo(() => {
    const all = state.groups.flatMap((g) => g.categories);
    return Object.fromEntries(FILTERS.map((f) => [f.value, all.filter((c) => matchesFilter(c, f.value)).length])) as Record<PlanFilter, number>;
  }, [state.groups]);
  const underfundedTotal = useMemo(
    () => state.groups.flatMap((g) => g.categories).reduce((s, c) => s + (c.target && !c.target.snoozed ? c.target.underfunded : 0n), 0n),
    [state.groups],
  );

  /** Optimistic budget action: apply locally, run the server action, then toast with Undo. */
  function mutate(optimistic: PlanAction | null, call: () => Promise<{ ok: true; operationId: string | null } | { ok: false; error: string }>, message: (r: { operationId: string | null }) => string) {
    startTransition(async () => {
      if (optimistic) addOptimistic(optimistic);
      const r = await call();
      if (!r.ok) toast.show({ message: r.error, tone: "error" });
      else undoToast(message(r), r.operationId);
    });
  }

  const all = state.groups.flatMap((g) => g.categories);
  const nameOf = (id: string) => (id === "rta" ? "Ready to Assign" : categoryLabel(all.find((c) => c.id === id)?.name ?? "category"));

  const onAssign = (categoryId: string, value: bigint) =>
    mutate({ type: "assign", categoryId, value }, () => assignAction({ month, categoryId, amount: value }), () => `${nameOf(categoryId)}: assigned ${formatMilli(value)}`);

  const onMove = (from: string, to: string, amount: bigint) =>
    mutate({ type: "move", from, to, amount }, () => moveMoneyAction({ month, from, to, amount }), () => `Moved ${formatMilli(amount)} from ${nameOf(from)} to ${nameOf(to)}`);

  const autoAssign = (mode: string, categoryIds?: string[]) => {
    const label = AUTO_ASSIGN_OPTIONS.find((o) => o.id === mode)?.label ?? mode;
    startTransition(async () => {
      if (mode === "underfunded") addOptimistic({ type: "fund_underfunded", categoryIds });
      const r = await autoAssignAction({ month, mode, categoryIds });
      if (!r.ok) toast.show({ message: r.error, tone: "error" });
      else if (r.count === 0) toast.show({ message: `Auto-Assign (${label}): nothing to change.` });
      else undoToast(`Auto-Assign (${label}): ${formatMilli(r.total, { sign: "always" })} across ${r.count} ${r.count === 1 ? "category" : "categories"}`, r.operationId);
    });
  };

  const saveNote = async (note: string) => {
    const r = await setMonthNoteAction({ month, note });
    if (!r.ok) toast.show({ message: r.error, tone: "error" });
  };

  const liveSummary: MonthSummaryVM = useMemo(() => {
    const delta = state.readyToAssign - plan.summary.readyToAssign;
    return {
      ...plan.summary,
      readyToAssign: state.readyToAssign,
      assignedThisMonth: plan.summary.assignedThisMonth - delta,
      available: plan.summary.available - delta,
    };
  }, [state.readyToAssign, plan.summary]);

  const open: CategoryVM | null = all.find((c) => c.id === openId) ?? plan.hidden.find((c) => c.id === openId) ?? null;
  const groupNameOf = (c: CategoryVM | null) => (c ? (state.groups.find((g) => g.id === c.groupId)?.name ?? "") : "");
  const visibleGroups = state.groups
    .map((g) => ({ ...g, visible: g.categories.filter((c) => matchesFilter(c, filter)) }))
    .filter((g) => g.visible.length > 0);
  const unc = plan.summary.uncategorized;
  const showUnc = !!unc && (unc.available !== 0n || unc.activity !== 0n);
  const hiddenByGroup = useMemo(() => {
    const m = new Map<string, CategoryVM[]>();
    for (const c of plan.hidden) {
      const g = plan.groups.find((x) => x.id === c.groupId)?.name ?? "Other";
      m.set(g, [...(m.get(g) ?? []), c]);
    }
    return [...m.entries()];
  }, [plan.hidden, plan.groups]);

  const assignMenu = (
    <ActionMenu
      label="Assign"
      trigger={
        <span className="inline-flex items-center gap-1.5">
          Assign <ChevronDown size={16} strokeWidth={2.6} aria-hidden />
        </span>
      }
      triggerClassName={RTA_BUTTON}
      items={AUTO_ASSIGN_ITEMS((mode) => autoAssign(mode))}
    />
  );

  const detailProps = {
    month,
    categoryOptions,
    recentCategoryIds,
    onAssign,
    onAutoAssign: (mode: string) => openId && autoAssign(mode, [openId]),
    onMove,
    onChanged: (message: string, operationId: string | null) => undoToast(message, operationId),
    onError: (message: string) => void toast.show({ message, tone: "error" }),
    scheduled,
    isHidden: !!openId && plan.hidden.some((c) => c.id === openId),
    onSetHidden: (hidden: boolean) => {
      if (!open) return;
      setHidden(open.id, hidden, open.name);
      setOpenId(null);
    },
  };

  const createGroup = async (name: string) => {
    const r = await createGroupAction(name);
    if (!r.ok) return r.error;
    toast.show({ message: `Added the ${name} group` });
    router.refresh();
    return null;
  };
  const createCategory = (groupId: string) => async (name: string) => {
    const r = await createCategoryAction(groupId, name);
    if (!r.ok) return r.error;
    toast.show({ message: `Added ${name}` });
    router.refresh();
    return null;
  };

  return (
    <PullToRefresh onRefresh={() => router.refresh()}>
      <h1 className="sr-only">Plan</h1>
      <div className="lg:grid lg:min-h-dvh lg:grid-cols-[minmax(0,1fr)_var(--inspector-w)]">
        <div className="min-w-0">
          {/* Desktop header: month · Ready to Assign · Age of Money */}
          <header className="hidden items-center gap-6 border-b border-rule px-6 py-3.5 lg:flex">
            <div className="min-w-[200px] flex-1">
              <MonthSwitcher month={month} currentMonth={today} hrefFor={(m) => (m === today ? "/plan" : `/plan?m=${monthParam(m)}`)} />
              <MonthNote note={plan.summary.note ?? ""} onSave={saveNote} className="mt-1.5 pl-1" />
            </div>
            <RTABanner amount={state.readyToAssign} assignedInFuture={plan.summary.assignedInFutureMonths} menu={assignMenu} className="w-[340px] shrink-0" />
            <div className="flex min-w-[160px] flex-1 justify-end">
              <div className="text-right">
                <div className="num text-[20px] font-bold leading-tight text-ink">{plan.summary.ageOfMoneyDays === null ? "—" : `${plan.summary.ageOfMoneyDays} days`}</div>
                <div className="flex items-center justify-end gap-0.5 text-[12.5px] font-semibold text-ink-3">
                  Age of Money <AgeOfMoneyTip align="end" />
                </div>
              </div>
            </div>
          </header>

          {/* Phone header: month, note, actions, then the green Ready to Assign banner */}
          <div className="lg:hidden">
            <div className="flex items-center gap-1 px-4 pb-1 pt-3">
              <div className="min-w-0 flex-1">
                <MonthSwitcher compact month={month} currentMonth={today} hrefFor={(m) => (m === today ? "/plan" : `/plan?m=${monthParam(m)}`)} />
              </div>
              <IconButton label="Recent moves" onClick={() => setMovesOpen(true)}>
                <History size={20} strokeWidth={2} />
              </IconButton>
              <IconButton label="Month summary" onClick={() => setSummaryOpen(true)}>
                <ChartPie size={20} strokeWidth={2} />
              </IconButton>
              <Avatar className="-mr-2" />
            </div>
            <MonthNote note={plan.summary.note ?? ""} onSave={saveNote} className="mb-2 px-5" />
            <RTABanner amount={state.readyToAssign} assignedInFuture={plan.summary.assignedInFutureMonths} menu={assignMenu} className="mx-4" />
          </div>

          {!hasBudgetAccounts && <FirstRun admin={!!admin} />}

          <div className="px-4 pb-2 pt-3 lg:px-6">
            <SegmentedControl
              label="Filter categories"
              variant="chips"
              value={filter}
              onChange={setFilter}
              options={FILTERS.map((f) => ({
                ...f,
                count: f.value === "all" ? undefined : counts[f.value],
                tone: f.value === "overspent" ? ("neg" as const) : undefined,
                icon: f.value === "overspent" && counts.overspent > 0 ? <TriangleAlert size={14} strokeWidth={2.4} aria-hidden /> : undefined,
              }))}
            />
          </div>

          {/* Desktop toolbar */}
          <div className="hidden items-center gap-1 border-b border-rule px-5 pb-2 lg:flex">
            <NamePopover
              label="New category group"
              placeholder="e.g. Kids"
              onSubmit={createGroup}
              triggerClassName={TOOL}
              trigger={
                <>
                  <Plus size={16} strokeWidth={2.4} aria-hidden /> Category Group
                </>
              }
            />
            <button type="button" className={TOOL} disabled={!lastUndoable || movesPending} onClick={() => lastUndoable && undoMove(lastUndoable.id)} title={lastUndoable ? `Undo: ${lastUndoable.description}` : "Nothing to undo"}>
              <Undo2 size={16} strokeWidth={2.2} aria-hidden /> Undo
            </button>
            <button type="button" className={TOOL} disabled={!lastRedoable || movesPending} onClick={() => lastRedoable && redoMove(lastRedoable.id)} title={lastRedoable ? `Redo: ${lastRedoable.description}` : "Nothing to redo"}>
              <Redo2 size={16} strokeWidth={2.2} aria-hidden /> Redo
            </button>
            <button type="button" className={TOOL} onClick={() => setMovesOpen(true)} aria-label="Recent moves">
              <History size={16} strokeWidth={2.2} aria-hidden /> Recent Moves
            </button>
            <div className="ml-auto flex items-center gap-1">
              <button type="button" className={cx(TOOL, "text-ink-3")} onClick={() => setCollapsed(Object.fromEntries(state.groups.map((g) => [g.id, !Object.values(collapsed).some(Boolean)])))} title="Collapse or expand all groups">
                <ListCollapse size={16} strokeWidth={2} aria-hidden />
                <span className="sr-only">Collapse or expand all groups</span>
              </button>
              <button type="button" className={cx(TOOL, "text-ink-3")} onClick={toggleDensity} aria-pressed={compact} title={compact ? "Comfortable rows" : "Compact rows"}>
                {compact ? <Rows3 size={16} strokeWidth={2} aria-hidden /> : <ListTree size={16} strokeWidth={2} aria-hidden />}
                <span className="sr-only">Compact rows</span>
              </button>
            </div>
          </div>

          <div className="lg:pb-24">
            <BudgetColumnHeader className="border-t border-rule lg:border-t-0" />
            {showUnc && unc && (
              <div className={cx(BUDGET_GRID, "min-h-[48px] border-b border-rule pl-4 pr-4 lg:pl-3 lg:pr-3")}>
                <span className="hidden lg:block" />
                <Link href={`/activity?category=${unc.id}`} className="flex min-h-11 items-center gap-2 text-[15px] font-semibold text-neg hover:underline">
                  <CircleAlert size={17} strokeWidth={2.2} aria-hidden /> Uncategorized Transactions
                </Link>
                <span className="hidden lg:block" />
                <Money value={unc.activity} className="hidden text-right text-[14px] text-ink-2 lg:block" />
                <span className="flex justify-end">
                  <MoneyPill value={unc.available} label="Uncategorized available" />
                </span>
              </div>
            )}
            {visibleGroups.length === 0 && (
              <EmptyState title="Nothing matches" className="mx-4 lg:mx-6">
                No categories are {FILTERS.find((f) => f.value === filter)?.label.toLowerCase()} this month.
              </EmptyState>
            )}
            {visibleGroups.map((g) => {
              const isCollapsed = !!collapsed[g.id];
              const regionId = `group-${g.id}`;
              return (
                <section key={g.id} aria-label={g.name} className="group/grp relative">
                  <GroupHeader
                    name={g.name}
                    count={g.visible.length}
                    assigned={g.visible.reduce((a, c) => a + c.assigned, 0n)}
                    activity={g.visible.reduce((a, c) => a + c.activity, 0n)}
                    available={g.visible.reduce((a, c) => a + c.available, 0n)}
                    collapsed={isCollapsed}
                    onToggle={() => setCollapsed((s) => ({ ...s, [g.id]: !s[g.id] }))}
                    controls={regionId}
                    payment={g.pinned}
                  />
                  {!g.pinned && (
                    <div className="absolute left-[calc(22px+12px+1rem+min(40%,220px))] top-1.5 z-20 hidden opacity-0 transition-opacity group-hover/grp:opacity-100 focus-within:opacity-100 lg:block">
                      <NamePopover
                        label={`New category in ${g.name}`}
                        placeholder="e.g. Coffee"
                        onSubmit={createCategory(g.id)}
                        triggerClassName="inline-flex h-7 w-7 items-center justify-center rounded-full bg-accent text-accent-contrast"
                        trigger={<Plus size={15} strokeWidth={2.6} aria-label={`Add a category to ${g.name}`} />}
                      />
                    </div>
                  )}
                  <div id={regionId} hidden={isCollapsed}>
                    {g.visible.map((c) => (
                      <CategoryRow key={c.id} category={c} onAssign={onAssign} onOpen={(id) => setOpenId((cur) => (cur === id && isDesktop ? null : id))} selected={c.id === openId} compact={compact} />
                    ))}
                  </div>
                </section>
              );
            })}
            {plan.hidden.length > 0 && (
              <div ref={hiddenRef} className="relative">
                <button
                  type="button"
                  aria-expanded={hiddenOpen}
                  aria-haspopup="dialog"
                  onClick={() => setHiddenOpen((v) => !v)}
                  className="flex min-h-11 w-full items-center gap-2 border-b border-rule px-4 text-left text-[14px] font-semibold text-ink-2 hover:bg-paper-hover lg:px-6"
                >
                  <EyeOff size={16} strokeWidth={2} aria-hidden className="text-ink-3" />
                  Hidden Categories <span className="num font-medium text-ink-3">({plan.hidden.length})</span>
                </button>
                {hiddenOpen && (
                  <div role="dialog" aria-label="Hidden categories" className="absolute left-4 top-full z-30 mt-1 max-h-[60vh] w-[320px] overflow-y-auto rounded-xl border border-rule bg-paper-raised p-3 shadow-pop lg:left-6" style={{ animation: "hb-pop 140ms var(--ease-out-quart)" }}>
                    <p className="mb-2 text-[12.5px] text-ink-3">Click to unhide a category</p>
                    {hiddenByGroup.map(([gname, cats]) => (
                      <div key={gname} className="mb-2">
                        <div className="eyebrow py-1">{gname}</div>
                        {cats.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            aria-label={`Unhide ${categoryLabel(c.name)}`}
                            onClick={() => {
                              setHidden(c.id, false, c.name);
                              setHiddenOpen(false);
                            }}
                            className="flex min-h-9 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-[14px] text-ink hover:bg-accent-soft"
                          >
                            <span className="truncate">{categoryLabel(c.name)}</span>
                            <Money value={c.available} tone={c.available < 0n ? "neg" : "muted"} className="text-[13px]" />
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <aside aria-label="Inspector" className="hidden border-l border-rule bg-paper-sunken lg:block">
          <div className="sticky top-0 max-h-dvh overflow-y-auto p-4">
            {open && isDesktop ? (
              <CategoryDetail key={open.id} {...detailProps} category={open} groupName={groupNameOf(open)} variant="inspector" onClose={() => setOpenId(null)} />
            ) : (
              <MonthInspector summary={liveSummary} underfunded={underfundedTotal} onAutoAssign={(mode) => autoAssign(mode)} />
            )}
          </div>
        </aside>
      </div>

      <Sheet open={summaryOpen} onClose={() => setSummaryOpen(false)} title={`${plan.label} summary`}>
        <div className="space-y-4">
          <MonthSummary summary={liveSummary} />
          <CostToBeMe summary={liveSummary} />
          <div className="flex items-center justify-between rounded-xl bg-paper-sunken px-4 py-3 text-[14px]">
            <span className="flex items-center gap-1 text-ink-2">
              Age of Money <AgeOfMoneyTip />
            </span>
            <span className="num font-bold">{plan.summary.ageOfMoneyDays === null ? "—" : `${plan.summary.ageOfMoneyDays} days`}</span>
          </div>
        </div>
      </Sheet>
      <Sheet open={movesOpen} onClose={() => setMovesOpen(false)} title="Recent moves" description={plan.label}>
        <RecentMoves moves={plan.recentMoves} onUndo={undoMove} onRedo={redoMove} pending={movesPending} />
      </Sheet>

      {!isDesktop && <CategorySheet {...detailProps} category={open} groupName={groupNameOf(open)} onClose={() => setOpenId(null)} />}
    </PullToRefresh>
  );
}

/** First-run checklist (no budget accounts yet). */
function FirstRun({ admin }: { admin: boolean }) {
  const steps = [
    { title: "Set up your accounts", body: "Connect your bank, then choose which accounts belong in the budget.", href: admin ? "/settings/connections" : "/activity", cta: admin ? "Connect a bank" : "Open accounts" },
    { title: "Import from YNAB", body: "Bring over your categories, targets and history in one go.", href: "/settings/imports", cta: "Go to imports" },
    { title: "Give every dollar a job", body: "Assign Ready to Assign to categories until it reaches $0.00.", href: "/settings/categories", cta: "Edit categories" },
  ];
  return (
    <section aria-label="Get started" className="card mx-4 mt-4 p-5 lg:mx-6">
      <h2 className="text-[18px] font-bold text-ink">Welcome! Let&rsquo;s set up your plan</h2>
      <p className="mt-1 text-[14px] text-ink-2">Three steps and you&rsquo;re budgeting together.</p>
      <ol className="mt-4 grid gap-3 lg:grid-cols-3">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-3 rounded-xl border border-rule p-3.5">
            <span className="num flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-[13px] font-bold text-accent-contrast">{i + 1}</span>
            <span className="min-w-0">
              <span className="block text-[15px] font-semibold text-ink">{s.title}</span>
              <span className="mt-0.5 block text-[13px] text-ink-2">{s.body}</span>
              <Link href={s.href} className="link mt-1.5 inline-block text-[13.5px]">
                {s.cta} →
              </Link>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
