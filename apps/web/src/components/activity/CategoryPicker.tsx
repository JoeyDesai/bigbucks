"use client";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Search } from "lucide-react";
import { cx } from "@/lib/cx";
import type { CategoryOption } from "@/lib/view-models";
import { Money } from "@/components/ui/Money";
import { CategoryIcon } from "@/components/icons/CategoryIcon";
import { categoryLabel } from "@/lib/category-icons";

export interface CategoryPickerProps {
  options: CategoryOption[];
  /** Category ids, most recent first. */
  recentIds?: string[];
  value?: string | null;
  onSelect: (option: CategoryOption) => void;
  /** Show each category's Available beside it. */
  showAvailable?: boolean;
  autoFocus?: boolean;
}

/** Normalize for search: case- and emoji-insensitive. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

/** Searchable category list with a "Recently used" section. Listbox semantics, arrow keys + Enter. */
export function CategoryPicker({ options, recentIds = [], value, onSelect, showAvailable = true, autoFocus }: CategoryPickerProps) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const sections = useMemo(() => {
    const nq = norm(q);
    const hits = nq ? options.filter((o) => norm(o.name).includes(nq) || norm(o.groupName).includes(nq)) : options;
    const out: { title: string; items: CategoryOption[] }[] = [];
    if (!nq && recentIds.length) {
      const recent = recentIds.map((id) => options.find((o) => o.id === id)).filter(Boolean) as CategoryOption[];
      if (recent.length) out.push({ title: "Recently used", items: recent });
    }
    const byGroup = new Map<string, CategoryOption[]>();
    for (const o of hits) byGroup.set(o.groupName, [...(byGroup.get(o.groupName) ?? []), o]);
    for (const [title, items] of byGroup) out.push({ title, items });
    return out;
  }, [q, options, recentIds]);

  const flat = sections.flatMap((s) => s.items.map((item) => ({ item, key: `${s.title}:${item.id}` })));

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = flat[active];
      if (hit) onSelect(hit.item);
    }
    requestAnimationFrame(() => listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" }));
  }

  let idx = -1;
  return (
    <div className="flex min-h-0 flex-col">
      <label className="relative block">
        <span className="sr-only">Search categories</span>
        <Search size={16} strokeWidth={1.75} aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
        <input
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={flat[active] ? `${listId}-${active}` : undefined}
          autoFocus={autoFocus}
          data-autofocus={autoFocus || undefined}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search categories"
          className="h-11 w-full rounded-lg border border-rule-strong bg-paper-raised pl-9 pr-3 text-ink outline-none placeholder:text-ink-3 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
        />
      </label>
      <div ref={listRef} id={listId} role="listbox" aria-label="Categories" className="mt-3 min-h-0 flex-1">
        {flat.length === 0 && <p className="py-6 text-[14px] text-ink-3">No category matches “{q}”.</p>}
        {sections.map((s) => (
          <div key={s.title} role="group" aria-label={s.title} className="mb-3">
            <div className="eyebrow py-1.5">{s.title}</div>
            {s.items.map((o) => {
              idx++;
              const i = idx;
              const isActive = i === active;
              return (
                <div
                  key={`${s.title}:${o.id}`}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={o.id === value}
                  data-active={isActive}
                  onClick={() => onSelect(o)}
                  onMouseMove={() => setActive(i)}
                  className={cx(
                    "flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-md px-2 text-[15px]",
                    isActive && "bg-accent-soft",
                    o.id === value && "font-semibold text-accent",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <CategoryIcon icon={o.icon} name={o.name} size={16} />
                    <span className="truncate">{categoryLabel(o.name)}</span>
                  </span>
                  {showAvailable && o.available !== undefined && <Money value={o.available} tone="signed" className="text-[13px]" />}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
