"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion, type PanInfo } from "motion/react";
import { ArrowLeftRight, Check, CheckCheck, ChevronDown, Keyboard, Search, Sparkles, Split, X } from "lucide-react";
import { formatMilli } from "@homebase/shared";
import { cx } from "@/lib/cx";
import { formatDay } from "@/lib/format";
import { useIsDesktop } from "@/lib/use-media";
import { enterAction, needsReview, samePayeeIds, type CategoryChoice, type TxItem } from "@/lib/tx";
import type { AccountVM, CategoryOption, TransactionVM } from "@/lib/view-models";
import { approveAction, restoreTransactionsAction, unapproveAction } from "@/server/actions/transactions";
import { categorizeAction, disableLearnedRuleAction, loadTxPageAction } from "@/server/actions/glow";
import type { TxMode } from "@/server/queries/glow";
import { TransactionSheet } from "@/components/activity/TransactionSheet";
import { CategoryIcon } from "@/components/icons/CategoryIcon";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { BucketPicker } from "./BucketPicker";
import { isTypingTarget } from "./ShortcutSheet";

type Override = Partial<Pick<TxItem, "categoryId" | "approved" | "needsCategory">>;
interface UndoEntry {
  label: string;
  run: () => Promise<void>;
}
interface PickerState {
  ids: string[];
  anchorId: string;
  query: string;
}
type SheetState = { id: string; mode?: "split" | "transfer" } | null;

const RESERVED = new Set(["e", "s", "t", "x", "u", "j", "k"]);

export interface TxListProps {
  items: TxItem[];
  nextCursor: string | null;
  total: number;
  mode: TxMode;
  /** Fixed account filter (account pages). */
  accountId?: string;
  choices: CategoryChoice[];
  recentIds: string[];
  accounts: AccountVM[];
  /** Hide the account column (account pages). */
  hideAccount?: boolean;
  query?: string;
}

function toVM(t: TxItem, names: Map<string, CategoryChoice>): TransactionVM {
  return {
    id: t.id,
    date: t.date,
    payee: t.payee,
    rawDescription: t.rawDescription ?? "",
    amount: t.amount,
    accountId: t.accountId,
    accountName: t.accountName,
    categoryId: t.categoryId,
    categoryName: t.categoryId ? (names.get(t.categoryId)?.name ?? null) : null,
    memo: t.memo ?? undefined,
    cleared: t.cleared,
    approved: t.approved,
    splits: t.isSplit ? t.splits.map((s) => ({ id: s.id, categoryId: s.categoryId, categoryName: s.categoryId ? (names.get(s.categoryId)?.name ?? null) : null, amount: s.amount, memo: s.memo ?? undefined })) : undefined,
    transferAccountName: t.transferAccountName ?? undefined,
    payeeId: t.payeeId,
  };
}

/**
 * The fast transaction list (Transactions tab and account pages). Keyboard first: ↑/↓ or j/k move,
 * Enter accepts the suggestion and approves, 1–3 pick a suggestion, any letter opens the bucket picker
 * on the row, x selects, Shift+↑/↓ extends, e/s/t edit/split/transfer, u undoes. Every change is
 * optimistic with an Undo toast; in "Needs review" the row slides out and the next one takes focus.
 * Touch: tap the suggestion to accept, swipe right to accept, swipe left for the picker.
 */
export function TxList({ items, nextCursor, total, mode, accountId, choices, recentIds, accounts, hideAccount, query = "" }: TxListProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const desktop = useIsDesktop();
  const reduce = useReducedMotion();
  const [, start] = useTransition();
  const names = useMemo(() => new Map(choices.map((c) => [c.id, c])), [choices]);

  const [overrides, setOverrides] = useState<Map<string, Override>>(new Map());
  const [more, setMore] = useState<{ items: TxItem[]; cursor: string | null }>({ items: [], cursor: nextCursor });
  const [rawFocusId, setFocusId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [search, setSearch] = useState(query);
  const undoStack = useRef<UndoEntry[]>([]);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // the server list changed (revalidation, filter, search): drop pagination that no longer applies
  const [seenItems, setSeenItems] = useState(items);
  if (seenItems !== items) {
    setSeenItems(items);
    setMore({ items: [], cursor: nextCursor });
  }

  const all = useMemo(() => {
    const seen = new Set<string>();
    const out: TxItem[] = [];
    for (const t of [...items, ...more.items]) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const o = overrides.get(t.id);
      out.push(o ? { ...t, ...o } : t);
    }
    return out;
  }, [items, more.items, overrides]);
  const rows = useMemo(() => (mode === "review" ? all.filter(needsReview) : all), [all, mode]);
  // the focused row; on desktop the first row is focused until you move
  const focusId = rawFocusId && rows.some((r) => r.id === rawFocusId) ? rawFocusId : desktop ? (rows[0]?.id ?? null) : null;
  const focusIndex = rows.findIndex((r) => r.id === focusId);
  const focused = focusIndex >= 0 ? rows[focusIndex]! : null;

  useEffect(() => {
    if (!focusId) return;
    listRef.current?.querySelector<HTMLElement>(`[data-tx-id="${focusId}"]`)?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [focusId, reduce]);

  const patch = useCallback((ids: string[], o: Override | null) => {
    setOverrides((m) => {
      const n = new Map(m);
      for (const id of ids) {
        if (o === null) n.delete(id);
        else n.set(id, { ...n.get(id), ...o });
      }
      return n;
    });
  }, []);

  /** Where focus goes after `ids` leave (or are handled): the next row that isn't one of them. */
  const advanceFrom = useCallback(
    (ids: string[]) => {
      const gone = new Set(ids);
      const idx = Math.max(0, rows.findIndex((r) => r.id === focusId));
      const after = rows.slice(idx).find((r) => !gone.has(r.id)) ?? [...rows.slice(0, idx)].reverse().find((r) => !gone.has(r.id));
      setFocusId(after?.id ?? null);
    },
    [rows, focusId],
  );

  const pushUndo = (e: UndoEntry) => {
    undoStack.current.push(e);
    if (undoStack.current.length > 30) undoStack.current.shift();
  };
  const runUndo = useCallback(
    (e?: UndoEntry) => {
      const entry = e ?? undoStack.current.pop();
      if (!entry) return void toast.show({ message: "Nothing to undo" });
      if (e) undoStack.current = undoStack.current.filter((x) => x !== e);
      start(async () => {
        await entry.run();
        toast.show({ message: `Undid ${entry.label}` });
      });
    },
    [toast],
  );

  const applyRef = useRef<((ids: string[], c: CategoryChoice, opts?: { advance?: boolean }) => void) | null>(null);
  const applyCategory = useCallback(
    (ids: string[], c: CategoryChoice, opts: { advance?: boolean } = {}) => {
      const targets = all.filter((t) => ids.includes(t.id) && !t.isSplit && !t.transferAccountName);
      if (!targets.length) return;
      const prev = targets.map((t) => ({ id: t.id, categoryId: t.categoryId, approved: t.approved, needsCategory: t.needsCategory }));
      const tids = targets.map((t) => t.id);
      if (opts.advance !== false) advanceFrom(tids);
      patch(tids, { categoryId: c.id, approved: true, needsCategory: false });
      setSelected(new Set());
      const first = targets[0]!;
      const label = tids.length === 1 ? `${first.payee} → ${c.name}` : `${tids.length} transactions → ${c.name}`;
      const undo: UndoEntry = {
        label,
        run: async () => {
          patch(tids, null);
          await restoreTransactionsAction(prev.map((p) => ({ id: p.id, categoryId: p.categoryId, approved: p.approved })));
        },
      };
      pushUndo(undo);
      start(async () => {
        const r = await categorizeAction({ ids: tids, categoryId: c.id, context: targets.map((t) => ({ id: t.id, payee: t.payeeName ?? t.payee, suggested: t.suggestions[0]?.categoryId ?? null })) });
        if (!r.ok) {
          patch(tids, null);
          undoStack.current = undoStack.current.filter((x) => x !== undo);
          return void toast.show({ message: r.error, tone: "error" });
        }
        if (r.learned) {
          const l = r.learned;
          toast.show({
            message: (
              <span className="flex items-center gap-2">
                <Sparkles size={15} strokeWidth={2} aria-hidden className="shrink-0 text-[var(--accent-d)]" /> {l.message}
              </span>
            ),
            duration: 9000,
            action: { label: "Undo", onAction: () => void disableLearnedRuleAction(l.ruleId).then(() => toast.show({ message: "Okay, I won't do that automatically" })) },
            secondary: l.reapplyIds.length ? { label: `Apply to ${l.reapplyIds.length} more`, onAction: () => applyRef.current?.(l.reapplyIds, c, { advance: false }) } : undefined,
          });
          return;
        }
        const others = tids.length === 1 ? samePayeeIds(all, first) : [];
        toast.show({
          message: (
            <span className="flex min-w-0 items-center gap-2">
              <CategoryIcon icon={c.icon} name={c.name} size={15} tone="inherit" className="text-[var(--accent-d)]" />
              <span className="truncate">{label}</span>
            </span>
          ),
          action: { label: "Undo", onAction: () => runUndo(undo) },
          secondary: others.length ? { label: `All ${others.length + 1} from ${first.payee.length > 14 ? "payee" : first.payee}`, onAction: () => applyRef.current?.(others, c, { advance: false }) } : undefined,
        });
      });
    },
    [all, advanceFrom, patch, toast, runUndo],
  );
  useEffect(() => {
    applyRef.current = applyCategory;
  }, [applyCategory]);

  const approve = useCallback(
    (ids: string[]) => {
      const targets = all.filter((t) => ids.includes(t.id) && !t.approved);
      if (!targets.length) return;
      const tids = targets.map((t) => t.id);
      advanceFrom(tids);
      patch(tids, { approved: true });
      setSelected(new Set());
      const undo: UndoEntry = {
        label: tids.length === 1 ? `approving ${targets[0]!.payee}` : `approving ${tids.length}`,
        run: async () => {
          patch(tids, null);
          await unapproveAction(tids);
        },
      };
      pushUndo(undo);
      start(async () => {
        const r = await approveAction(tids);
        if (!r.ok) {
          patch(tids, null);
          return void toast.show({ message: r.error, tone: "error" });
        }
        toast.show({ message: tids.length === 1 ? `Approved ${targets[0]!.payee}` : `Approved ${tids.length} transactions`, action: { label: "Undo", onAction: () => runUndo(undo) } });
      });
    },
    [all, advanceFrom, patch, toast, runUndo],
  );

  /** Enter on one row (or each selected row). */
  const accept = useCallback(
    (ids: string[]) => {
      const targets = all.filter((t) => ids.includes(t.id));
      const byCat = new Map<string, string[]>();
      const toApprove: string[] = [];
      let pickFor: TxItem | null = null;
      for (const t of targets) {
        const a = enterAction(t);
        if (a.kind === "categorize") byCat.set(a.categoryId, [...(byCat.get(a.categoryId) ?? []), t.id]);
        else if (a.kind === "approve") toApprove.push(t.id);
        else pickFor ??= t;
      }
      if (!byCat.size && !toApprove.length && pickFor) return setPicker({ ids: [pickFor.id], anchorId: pickFor.id, query: "" });
      for (const [cid, tids] of byCat) {
        const c = names.get(cid);
        if (c) applyCategory(tids, c);
      }
      if (toApprove.length) approve(toApprove);
    },
    [all, names, applyCategory, approve],
  );

  const openPicker = useCallback(
    (t: TxItem, q = "") => {
      const ids = selected.size && selected.has(t.id) ? [...selected] : selected.size ? [...selected] : [t.id];
      setFocusId(t.id);
      setPicker({ ids, anchorId: t.id, query: q });
    },
    [selected],
  );

  const moveFocus = useCallback(
    (delta: number, extend: boolean) => {
      if (!rows.length) return;
      const i = focusIndex < 0 ? (delta > 0 ? -1 : rows.length) : focusIndex;
      const n = Math.max(0, Math.min(rows.length - 1, i + delta));
      const next = rows[n]!;
      if (extend) {
        const a = anchor ?? focusId ?? next.id;
        setAnchor(a);
        const ai = rows.findIndex((r) => r.id === a);
        const [lo, hi] = ai < n ? [ai, n] : [n, ai];
        setSelected(new Set(rows.slice(lo, hi + 1).map((r) => r.id)));
      } else setAnchor(null);
      setFocusId(next.id);
    },
    [rows, focusIndex, anchor, focusId],
  );

  // ── keyboard ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (picker || sheet || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const k = e.key;
      const t = focused;
      if (k === "ArrowDown" || k === "j") {
        e.preventDefault();
        moveFocus(1, e.shiftKey);
      } else if (k === "ArrowUp" || k === "k") {
        e.preventDefault();
        moveFocus(-1, e.shiftKey);
      } else if (k === "Enter" && t) {
        e.preventDefault();
        if (e.shiftKey) {
          const top = enterAction(t);
          const c = top.kind === "categorize" ? names.get(top.categoryId) : t.categoryId ? names.get(t.categoryId) : undefined;
          if (c) applyCategory([t.id, ...samePayeeIds(all, t)], c);
          else openPicker(t);
        } else accept(selected.size ? [...selected] : [t.id]);
      } else if ((k === "1" || k === "2" || k === "3") && t) {
        const s = t.suggestions[Number(k) - 1];
        const c = s && names.get(s.categoryId);
        if (c) {
          e.preventDefault();
          applyCategory(selected.size ? [...selected] : [t.id], c);
        }
      } else if (k === "x" && t) {
        e.preventDefault();
        setSelected((sel) => {
          const n = new Set(sel);
          if (n.has(t.id)) n.delete(t.id);
          else n.add(t.id);
          return n;
        });
        setAnchor(t.id);
      } else if (k === "u") {
        e.preventDefault();
        runUndo();
      } else if (k === "e" && t) {
        e.preventDefault();
        setSheet({ id: t.id });
      } else if (k === "s" && t) {
        e.preventDefault();
        if (t.transferAccountName) return void toast.show({ message: "A transfer can't be split" });
        setSheet({ id: t.id, mode: "split" });
      } else if (k === "t" && t) {
        e.preventDefault();
        if (t.transferAccountName || t.isSplit) return void toast.show({ message: t.isSplit ? "A split can't be a transfer" : "Already a transfer" });
        setSheet({ id: t.id, mode: "transfer" });
      } else if (k === "Escape") {
        if (selected.size) {
          e.preventDefault();
          setSelected(new Set());
        }
      } else if (k === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (k === " " && t) {
        e.preventDefault();
        openPicker(t);
      } else if (t && k.length === 1 && /[a-z]/i.test(k) && !(RESERVED.has(k) && !e.shiftKey)) {
        e.preventDefault();
        openPicker(t, k);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focused, picker, sheet, moveFocus, accept, applyCategory, names, all, selected, runUndo, openPicker, toast]);

  // ── filters ──
  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params.toString());
    if (v === null || v === "") p.delete(k);
    else p.set(k, v);
    const s = p.toString();
    setOverrides(new Map());
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };
  useEffect(() => {
    if (search === query) return;
    const t = setTimeout(() => setParam("q", search.trim() || null), 280);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const loadMore = () =>
    start(async () => {
      if (!more.cursor) return;
      const r = await loadTxPageAction({ mode, accountId, q: query || undefined }, more.cursor);
      setMore((m) => ({ items: [...m.items, ...r.items], cursor: r.nextCursor }));
    });

  const reviewCount = mode === "review" ? rows.length : null;
  const sheetTx = sheet ? all.find((t) => t.id === sheet.id) : null;
  const options: CategoryOption[] = useMemo(() => choices.map((c) => ({ id: c.id, name: c.name, groupName: c.groupName, icon: c.icon })), [choices]);
  const pickerTx = picker ? all.find((t) => t.id === picker.anchorId) : null;
  /** From the bucket picker: close it and open the split editor for that one transaction. */
  const openSplit = (id: string) => {
    setPicker(null);
    setSheet({ id, mode: "split" });
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 sm:mb-4">
        <div role="radiogroup" aria-label="Show" className="glass inline-flex rounded-full p-1">
          {(
            [
              ["review", "Needs review"],
              ["all", "All"],
            ] as const
          ).map(([v, l]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={mode === v}
              onClick={() => setParam("view", v === (accountId ? "all" : "review") ? null : v)}
              className={cx("relative h-8 rounded-full px-3.5 text-[13px] font-semibold transition-colors", mode === v ? "text-ink" : "text-ink-3 hover:text-ink-2")}
            >
              {mode === v && <motion.span layoutId={`seg-${accountId ?? "all"}`} className="absolute inset-0 rounded-full bg-paper shadow-[0_1px_2px_rgba(16,20,40,0.08),0_4px_14px_-6px_var(--accent-glow)]" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
              <span className="relative">
                {l}
                {v === "review" && mode === "review" && <span className="num ml-1.5 text-accent">{reviewCount}</span>}
              </span>
            </button>
          ))}
        </div>
        <label className="glass ml-auto flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full px-3.5 sm:max-w-[300px]">
          <Search size={15} strokeWidth={2} aria-hidden className="shrink-0 text-ink-3" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearch("");
                (e.target as HTMLInputElement).blur();
              } else if (e.key === "Enter" || e.key === "ArrowDown") (e.target as HTMLInputElement).blur();
            }}
            placeholder="Search payee or memo"
            aria-label="Search transactions"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
          />
          <kbd className="kbd hidden sm:inline-flex">/</kbd>
        </label>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("hb:shortcuts"))}
          className="glass hidden h-10 items-center gap-2 rounded-full px-3.5 text-[13px] font-medium text-ink-2 hover:text-ink lg:inline-flex"
          aria-label="Keyboard shortcuts"
        >
          <Keyboard size={15} strokeWidth={1.9} aria-hidden /> <kbd className="kbd">?</kbd>
        </button>
      </div>

      <AnimatePresence>
        {selected.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="sticky top-[calc(var(--safe-top)+8px)] z-20 mb-3 flex items-center gap-2 rounded-[16px] bg-nav px-3 py-2 text-[13.5px] text-white shadow-pop"
            role="status"
          >
            <span className="font-semibold">{selected.size} selected</span>
            <span className="hidden text-white/60 sm:inline">· type a bucket, or press Enter to accept each suggestion</span>
            <span className="ml-auto flex gap-1">
              <button type="button" onClick={() => focused && openPicker(focused)} className="h-8 rounded-[10px] bg-white/12 px-3 font-semibold hover:bg-white/20">
                Categorize
              </button>
              <button type="button" onClick={() => approve([...selected])} className="h-8 rounded-[10px] px-3 font-semibold hover:bg-white/12">
                Approve
              </button>
              <button type="button" aria-label="Clear selection" onClick={() => setSelected(new Set())} className="inline-flex h-8 w-8 items-center justify-center rounded-[10px] hover:bg-white/12">
                <X size={15} />
              </button>
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {rows.length === 0 ? (
        <Empty mode={mode} searching={!!query} />
      ) : (
        <ul ref={listRef} role="listbox" aria-label="Transactions" aria-multiselectable className="card relative overflow-visible p-1.5" data-mode={mode}>
          <AnimatePresence initial={false} mode="popLayout">
            {rows.map((t, i) => (
              <Row
                key={t.id}
                t={t}
                index={i}
                focused={t.id === focusId}
                selected={selected.has(t.id)}
                names={names}
                hideAccount={hideAccount}
                reduce={!!reduce}
                touch={!desktop}
                onFocus={(ev) => {
                  if (ev.shiftKey && focusId) {
                    const a = anchor ?? focusId;
                    setAnchor(a);
                    const ai = rows.findIndex((r) => r.id === a);
                    const [lo, hi] = ai < i ? [ai, i] : [i, ai];
                    setSelected(new Set(rows.slice(lo, hi + 1).map((r) => r.id)));
                  } else if (ev.metaKey || ev.ctrlKey) {
                    setSelected((sel) => {
                      const n = new Set(sel);
                      if (n.has(t.id)) n.delete(t.id);
                      else n.add(t.id);
                      return n;
                    });
                    setAnchor(t.id);
                  } else setAnchor(t.id);
                  setFocusId(t.id);
                }}
                onAccept={() => accept([t.id])}
                onPick={() => openPicker(t)}
                onEdit={() => setSheet({ id: t.id })}
                pickerOpen={desktop && picker?.anchorId === t.id}
                picker={
                  desktop && picker?.anchorId === t.id ? (
                    <BucketPicker
                      key={picker.anchorId + picker.query}
                      choices={choices}
                      initialQuery={picker.query}
                      suggestions={t.suggestions}
                      recentIds={recentIds}
                      label={picker.ids.length > 1 ? `Choose a bucket for ${picker.ids.length} transactions` : `Choose a bucket for ${t.payee}`}
                      onClose={() => setPicker(null)}
                      onPick={(c) => {
                        setPicker(null);
                        applyCategory(picker.ids, c);
                      }}
                      onSplit={picker.ids.length === 1 && !t.transferAccountName ? () => openSplit(t.id) : undefined}
                    />
                  ) : null
                }
              />
            ))}
          </AnimatePresence>
        </ul>
      )}
      {mode === "all" && more.cursor && (
        <div className="mt-4 flex justify-center">
          <button type="button" onClick={loadMore} className="glass h-10 rounded-full px-5 text-[13.5px] font-semibold text-ink-2 hover:text-ink">
            Load more
          </button>
        </div>
      )}
      {mode === "all" && <p className="mt-3 text-center text-[12px] text-ink-3">{total.toLocaleString()} transactions</p>}

      {/* phones: the picker is a bottom sheet */}
      <Sheet open={!desktop && !!picker} onClose={() => setPicker(null)} title={pickerTx ? (picker!.ids.length > 1 ? `${picker!.ids.length} transactions` : pickerTx.payee) : "Choose a bucket"} description={pickerTx && picker!.ids.length === 1 ? `${formatMilli(pickerTx.amount)} · ${formatDay(pickerTx.date)}` : undefined}>
        {!desktop && picker && pickerTx && (
          <BucketPicker
            key={picker.anchorId}
            choices={choices}
            initialQuery={picker.query}
            suggestions={pickerTx.suggestions}
            recentIds={recentIds}
            maxHeight={9999}
            className="-mx-4 -my-4"
            onClose={() => setPicker(null)}
            onPick={(c) => {
              const ids = picker.ids;
              setPicker(null);
              applyCategory(ids, c);
            }}
            onSplit={picker.ids.length === 1 && !pickerTx.transferAccountName ? () => openSplit(pickerTx.id) : undefined}
          />
        )}
      </Sheet>

      {sheetTx && (
        <TransactionSheet
          key={`${sheetTx.id}-${sheet?.mode ?? "edit"}`}
          open
          initialMode={sheet?.mode}
          onClose={() => setSheet(null)}
          tx={toVM(sheetTx, names)}
          accounts={accounts}
          categoryOptions={options}
          recentCategoryIds={recentIds}
          onSaved={(message, undo) => {
            patch([sheetTx.id], null);
            if (undo) pushUndo({ label: message.toLowerCase(), run: undo });
            toast.show({ message, action: undo ? { label: "Undo", onAction: () => void undo() } : undefined });
          }}
          onError={(message) => toast.show({ message, tone: "error" })}
        />
      )}
    </div>
  );
}

function Empty({ mode, searching }: { mode: TxMode; searching: boolean }) {
  return (
    <div className="card flex flex-col items-center px-6 py-16 text-center" data-testid="tx-empty">
      <motion.span
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 18 }}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-accent text-accent-contrast shadow-[0_0_0_8px_var(--accent-soft),0_0_40px_var(--accent-glow)]"
      >
        <CheckCheck size={26} strokeWidth={2.2} aria-hidden />
      </motion.span>
      <h2 className="display mt-5 text-[22px] text-ink">{searching ? "No matches" : mode === "review" ? "All caught up" : "No transactions yet"}</h2>
      <p className="mt-1.5 max-w-[340px] text-[14px] text-ink-3">{searching ? "Try a different payee or memo." : mode === "review" ? "Every transaction has a bucket and is approved. New ones from the bank land here." : "Connect an account or import a file in Settings."}</p>
    </div>
  );
}

function Chip({ t, names, onAccept, onPick, onEdit, focused }: { t: TxItem; names: Map<string, CategoryChoice>; onAccept: () => void; onPick: () => void; onEdit: () => void; focused: boolean }) {
  const base = "pointer-events-auto inline-flex h-8 max-w-full items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium transition-all";
  if (t.transferAccountName)
    return (
      <span className={cx(base, "bg-paper-sunken text-ink-2")}>
        <ArrowLeftRight size={13} strokeWidth={2} aria-hidden /> <span className="truncate">Transfer</span>
        {!t.approved && <ApproveTick onAccept={onAccept} />}
      </span>
    );
  if (t.isSplit)
    return (
      <span className="pointer-events-auto inline-flex max-w-full items-center gap-1">
        <button type="button" onClick={onEdit} title="Edit split" data-chip="split" className={cx(base, "bg-paper-sunken text-ink-2 hover:bg-accent-soft hover:text-ink")}>
          <Split size={13} strokeWidth={2} aria-hidden /> Split · {t.splitCount}
        </button>
        {!t.approved && <ApproveTick onAccept={onAccept} />}
      </span>
    );
  if (t.needsCategory) {
    const s = t.suggestions[0];
    const c = s ? names.get(s.categoryId) : undefined;
    if (!c)
      return (
        <button type="button" onClick={onPick} className={cx(base, "border border-dashed border-rule-strong text-ink-3 hover:border-accent hover:text-accent")} data-chip="empty">
          Choose a bucket
        </button>
      );
    return (
      <span className="pointer-events-auto inline-flex max-w-full items-center gap-1">
        <button
          type="button"
          onClick={onPick}
          title="Change bucket"
          aria-label={`Suggested ${c.name}. Change bucket`}
          data-chip="suggestion"
          className={cx(base, "border border-dashed border-accent/55 bg-accent-soft/50 text-accent hover:border-solid hover:bg-accent-soft", focused && "shadow-[0_0_0_3px_var(--accent-soft),0_0_18px_-4px_var(--accent-glow)]")}
        >
          <CategoryIcon icon={c.icon} name={c.name} size={14} tone="accent" />
          <span className="truncate">{c.name}</span>
        </button>
        <ApproveTick onAccept={onAccept} label={`Accept ${c.name}`} />
      </span>
    );
  }
  const c = t.categoryId ? names.get(t.categoryId) : undefined;
  return (
    <span className="pointer-events-auto inline-flex max-w-full items-center gap-1">
      <button type="button" onClick={onPick} title="Change bucket" className={cx(base, "group/chip bg-paper-sunken text-ink hover:bg-accent-soft")} data-chip="category">
        {c && <CategoryIcon icon={c.icon} name={c.name} size={14} tone="accent" />}
        <span className="truncate">{c?.name ?? "Category"}</span>
        <ChevronDown size={13} strokeWidth={2} aria-hidden className="-mr-0.5 shrink-0 text-ink-3 group-hover/chip:text-ink-2" />
      </button>
      {!t.approved && <ApproveTick onAccept={onAccept} />}
    </span>
  );
}

function ApproveTick({ onAccept, label = "Approve" }: { onAccept: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onAccept();
      }}
      aria-label={label}
      title={`${label} (Enter)`}
      className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-full bg-accent text-accent-contrast shadow-[0_0_12px_-2px_var(--accent-glow)] transition-transform hover:scale-105"
    >
      <Check size={14} strokeWidth={2.6} />
    </button>
  );
}

function Row({
  t,
  index,
  focused,
  selected,
  names,
  hideAccount,
  reduce,
  touch,
  onFocus,
  onAccept,
  onPick,
  onEdit,
  picker,
  pickerOpen,
}: {
  t: TxItem;
  index: number;
  focused: boolean;
  selected: boolean;
  names: Map<string, CategoryChoice>;
  hideAccount?: boolean;
  reduce: boolean;
  touch: boolean;
  onFocus: (e: React.MouseEvent) => void;
  onAccept: () => void;
  onPick: () => void;
  onEdit: () => void;
  picker: React.ReactNode;
  pickerOpen: boolean;
}) {
  const inflow = t.amount > 0n;
  const [swipe, setSwipe] = useState(0);
  const onDragEnd = (_: unknown, info: PanInfo) => {
    setSwipe(0);
    if (info.offset.x > 90) onAccept();
    else if (info.offset.x < -90) onPick();
  };
  return (
    <motion.li
      layout={reduce ? false : "position"}
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, transition: { delay: Math.min(index, 12) * 0.02, duration: 0.35, ease: [0.16, 1, 0.3, 1] } }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, x: 48, scale: 0.98, transition: { duration: 0.28, ease: [0.4, 0, 1, 1] } }}
      role="option"
      aria-selected={selected}
      data-tx-id={t.id}
      data-focused={focused || undefined}
      data-needs-review={needsReview(t) || undefined}
      className={cx("relative", pickerOpen && "z-30")}
    >
      {touch && (
        <div aria-hidden className="absolute inset-0 flex items-center justify-between overflow-hidden rounded-[14px] px-5 text-[13px] font-semibold">
          <span className={cx("flex items-center gap-1.5 text-accent transition-opacity", swipe > 20 ? "opacity-100" : "opacity-0")}>
            <Check size={16} strokeWidth={2.4} /> Accept
          </span>
          <span className={cx("flex items-center gap-1.5 text-ink-2 transition-opacity", swipe < -20 ? "opacity-100" : "opacity-0")}>Choose bucket</span>
        </div>
      )}
      <motion.div
        drag={touch ? "x" : false}
        dragDirectionLock
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.5}
        dragSnapToOrigin
        onDrag={(_, info) => setSwipe(info.offset.x)}
        onDragEnd={onDragEnd}
        onClick={onFocus}
        onDoubleClick={onEdit}
        className={cx(
          "relative grid cursor-default items-center gap-x-3 rounded-[14px] px-3 py-2.5 transition-[background-color,box-shadow] duration-150",
          hideAccount ? "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[52px_minmax(0,1fr)_minmax(0,240px)_112px]" : "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[52px_minmax(0,1fr)_150px_minmax(0,240px)_112px]",
          selected ? "bg-accent-soft" : focused ? "bg-paper-hover" : "bg-paper-raised hover:bg-paper-hover",
          focused && "shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--accent)_55%,transparent),0_6px_22px_-12px_var(--accent-glow)]",
        )}
      >
        {focused && <span aria-hidden className="absolute inset-y-3 left-0 w-[3px] rounded-full bg-accent shadow-[0_0_10px_var(--accent-glow)]" />}
        <span className="num hidden text-[12.5px] text-ink-3 sm:block">{formatDay(t.date)}</span>
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            {selected && <Check size={14} strokeWidth={2.6} aria-hidden className="shrink-0 text-accent" />}
            <span className="truncate text-[14.5px] font-medium text-ink">{t.payee}</span>
            {t.cleared === "pending" && <span className="shrink-0 rounded-full bg-paper-sunken px-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-ink-3">Pending</span>}
          </span>
          <span className="block truncate text-[12px] text-ink-3">
            <span className="sm:hidden">{formatDay(t.date)} · </span>
            {!hideAccount && <span className="sm:hidden">{t.accountName}</span>}
            {t.memo ? <span>{!hideAccount ? <span className="sm:hidden"> · </span> : null}{t.memo}</span> : null}
          </span>
        </span>
        {!hideAccount && <span className="hidden truncate text-[13px] text-ink-2 sm:block">{t.accountName}</span>}
        <span className="relative col-span-2 row-start-2 mt-1.5 min-w-0 sm:col-span-1 sm:row-start-auto sm:mt-0">
          <Chip t={t} names={names} onAccept={onAccept} onPick={onPick} onEdit={onEdit} focused={focused} />
          {picker && (
            <motion.div
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: "spring", stiffness: 520, damping: 34 }}
              className="glass absolute right-0 top-[calc(100%+6px)] z-40 w-[320px] overflow-hidden rounded-[16px] shadow-pop xl:left-0 xl:right-auto"
              style={{ background: "var(--glass-strong)" }}
              onClick={(e) => e.stopPropagation()}
            >
              {picker}
            </motion.div>
          )}
        </span>
        <span className={cx("num col-start-2 row-start-1 text-right text-[14.5px] font-semibold sm:col-start-auto sm:row-start-auto", inflow ? "text-pos" : "text-ink")}>
          {formatMilli(t.amount, { sign: inflow ? "always" : "auto" })}
        </span>
      </motion.div>
    </motion.li>
  );
}
