"use client";
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { cx } from "@/lib/cx";
import { ICON_SYNONYMS, iconKeyFor } from "@/lib/category-icons";
import { CATEGORY_ICONS } from "./icon-map";
import { hasCategoryIcon } from "./CategoryIcon";

const KEYS = Object.keys(CATEGORY_ICONS).sort();
const words = (k: string) => `${k.replace(/-/g, " ")} ${ICON_SYNONYMS[k] ?? ""}`.toLowerCase();

/**
 * Searchable grid of the curated category icons. `value` is the stored key (null = automatic from the
 * name); picking "Automatic" clears it.
 */
export function IconPicker({ value, name, onPick, className }: { value: string | null | undefined; name: string; onPick: (icon: string | null) => void; className?: string }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? KEYS.filter((k) => n.split(/\s+/).every((w) => words(k).includes(w))) : KEYS;
  }, [q]);
  const auto = iconKeyFor(null, name, hasCategoryIcon);
  const AutoIcon = CATEGORY_ICONS[auto]!;
  return (
    <div className={cx("flex min-h-0 flex-col", className)}>
      <label className="relative block">
        <span className="sr-only">Search icons</span>
        <Search size={16} strokeWidth={1.75} aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search icons (car, groceries, gift…)"
          data-autofocus
          className="h-10 w-full rounded-lg border border-rule-strong bg-paper-raised pl-9 pr-3 text-[14px] outline-none placeholder:text-ink-3 focus:border-accent"
        />
      </label>
      <button
        type="button"
        onClick={() => onPick(null)}
        aria-pressed={!value}
        className={cx("mt-2 flex min-h-10 items-center gap-2 rounded-lg border px-3 text-left text-[13.5px]", !value ? "border-accent bg-accent-soft text-accent" : "border-rule text-ink-2 hover:border-rule-strong")}
      >
        <AutoIcon size={17} strokeWidth={2} aria-hidden />
        Automatic (from the name)
      </button>
      <div role="listbox" aria-label="Icons" className="mt-2 grid max-h-[300px] grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-1 overflow-y-auto p-0.5">
        {shown.map((k) => {
          const Icon = CATEGORY_ICONS[k]!;
          const sel = value === k;
          return (
            <button
              key={k}
              type="button"
              role="option"
              aria-selected={sel}
              aria-label={k.replace(/-/g, " ")}
              title={k.replace(/-/g, " ")}
              onClick={() => onPick(k)}
              className={cx("flex h-11 items-center justify-center rounded-lg transition-colors", sel ? "bg-accent text-accent-contrast" : "text-ink-2 hover:bg-accent-soft hover:text-accent")}
            >
              <Icon size={20} strokeWidth={1.9} aria-hidden />
            </button>
          );
        })}
        {shown.length === 0 && <p className="col-span-full py-4 text-[13px] text-ink-3">No icon matches “{q}”.</p>}
      </div>
    </div>
  );
}
