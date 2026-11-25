"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Search, Split } from "lucide-react";
import { cx } from "@/lib/cx";
import { rankChoices, type CategoryChoice, type TxSuggestion } from "@/lib/tx";
import { CategoryIcon } from "@/components/icons/CategoryIcon";

/**
 * Instant fuzzy bucket picker. Opens with whatever letter was typed ("g" → Gas, Gifts, Groceries…);
 * ↑/↓ move, Enter picks, Esc closes. With no query: the row's suggestions (tagged Suggested), recently
 * used, then every bucket in plan order. With `onSplit`, a footer action opens the split editor.
 */
export function BucketPicker({
  choices,
  initialQuery = "",
  suggestions = [],
  recentIds = [],
  onPick,
  onClose,
  label = "Choose a bucket",
  className,
  maxHeight = 340,
  onSplit,
}: {
  choices: CategoryChoice[];
  initialQuery?: string;
  suggestions?: TxSuggestion[];
  recentIds?: string[];
  onPick: (c: CategoryChoice) => void;
  onClose: () => void;
  label?: string;
  className?: string;
  maxHeight?: number;
  /** Shows "Split between buckets" under the list (single, non-transfer transactions). */
  onSplit?: () => void;
}) {
  const [q, setQ] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const id = useId();
  const sugIds = useMemo(() => suggestions.map((s) => s.categoryId), [suggestions]);
  const ranked = useMemo(() => rankChoices(choices, q, { recentIds, suggestionIds: sugIds }), [choices, q, recentIds, sugIds]);
  const recent = useMemo(() => new Set(recentIds), [recentIds]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const n = el.value.length;
    el.setSelectionRange(n, n);
  }, []);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (i: number) => {
    const c = ranked[i];
    if (c) onPick(c);
  };

  return (
    <div className={cx("flex flex-col", className)} role="dialog" aria-label={label}>
      <label className="flex items-center gap-2 border-b border-rule px-3.5 py-2.5">
        <Search size={16} strokeWidth={2} aria-hidden className="shrink-0 text-ink-3" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(ranked.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              pick(active);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            } else if (e.key === "Tab") {
              e.preventDefault();
              setActive((a) => (e.shiftKey ? Math.max(0, a - 1) : Math.min(ranked.length - 1, a + 1)));
            }
          }}
          role="combobox"
          aria-expanded
          aria-controls={id}
          aria-activedescendant={ranked[active] ? `${id}-${active}` : undefined}
          aria-label="Search buckets"
          placeholder="Type a bucket…"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3"
        />
        <kbd className="kbd hidden sm:inline-flex">esc</kbd>
      </label>
      <ul ref={listRef} id={id} role="listbox" aria-label="Buckets" className="overflow-y-auto overscroll-contain p-1.5" style={{ maxHeight }}>
        {ranked.length === 0 && <li className="px-3 py-6 text-center text-[13.5px] text-ink-3">No bucket matches “{q}”</li>}
        {ranked.map((c, i) => {
          const tag = !q && sugIds.includes(c.id) ? "Suggested" : !q && recent.has(c.id) ? "Recent" : null;
          return (
            <li
              key={c.id}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              data-index={i}
              onMouseMove={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
              className={cx("flex min-h-11 cursor-pointer items-center gap-3 rounded-[10px] px-2.5 transition-colors", i === active ? "bg-accent-soft" : "")}
            >
              <span className={cx("flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px]", i === active ? "bg-paper" : "bg-paper-sunken")}>
                <CategoryIcon icon={c.icon} name={c.name} size={15} tone="accent" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-ink">{c.name}</span>
              </span>
              <span className="shrink-0 text-[11.5px] text-ink-3">{tag ?? c.groupName}</span>
              {i === active && <kbd className="kbd hidden sm:inline-flex">↵</kbd>}
            </li>
          );
        })}
      </ul>
      {onSplit && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onSplit}
          data-testid="picker-split"
          className="flex min-h-11 items-center gap-3 border-t border-rule px-4 text-left text-[14px] font-medium text-ink-2 transition-colors hover:bg-accent-soft hover:text-ink"
        >
          <Split size={16} strokeWidth={2} aria-hidden className="text-accent" />
          <span className="flex-1">Split between buckets…</span>
        </button>
      )}
    </div>
  );
}
