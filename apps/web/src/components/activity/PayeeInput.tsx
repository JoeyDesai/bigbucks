"use client";
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { cx } from "@/lib/cx";
import type { PayeeOption } from "@/server/queries/scheduled";

export interface PayeeInputProps {
  value: string;
  onChange: (name: string) => void;
  /** A known payee was picked (lets the form fill the payee's default category). */
  onPick?: (payee: PayeeOption) => void;
  payees: PayeeOption[];
  id?: string;
  className?: string;
}

/** Payee field with autocomplete over known payees (most used first). Combobox semantics. */
export function PayeeInput({ value, onChange, onPick, payees, id, className }: PayeeInputProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = value.trim().toLowerCase();
  const hits = useMemo(() => {
    if (!q) return [];
    const starts = payees.filter((p) => p.name.toLowerCase().startsWith(q));
    const contains = payees.filter((p) => !p.name.toLowerCase().startsWith(q) && p.name.toLowerCase().includes(q));
    return [...starts, ...contains].filter((p) => p.name.toLowerCase() !== q).slice(0, 6);
  }, [payees, q]);
  const show = open && hits.length > 0;

  const pick = (p: PayeeOption) => {
    onChange(p.name);
    onPick?.(p);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!show) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(hits[active]!);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <input
        id={id}
        role="combobox"
        aria-expanded={show}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={show ? `${listId}-${active}` : undefined}
        value={value}
        autoComplete="off"
        placeholder="Who was it?"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
        className={className}
      />
      {show && (
        <ul id={listId} role="listbox" aria-label="Payees" className="absolute inset-x-0 top-full z-10 mt-1 border border-rule-strong bg-paper-raised py-1" style={{ animation: "hb-pop 120ms var(--ease-out-quart)" }}>
          {hits.map((p, i) => (
            <li
              key={p.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(p);
              }}
              onMouseMove={() => setActive(i)}
              className={cx("flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 text-[15px]", i === active && "bg-paper-sunken")}
            >
              <span className="truncate">{p.name}</span>
              {p.defaultCategoryName && <span className="truncate text-[12px] text-ink-3">{p.defaultCategoryName}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
