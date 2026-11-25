"use client";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "@/lib/cx";

export type ActionMenuItem =
  | {
      type?: "item";
      id: string;
      label: string;
      description?: string;
      icon?: ReactNode;
      onSelect: () => void;
      destructive?: boolean;
      disabled?: boolean;
      /** Radio-style item (e.g. theme choice): shows a check and uses role menuitemradio. */
      checked?: boolean;
    }
  | { type: "separator"; id: string }
  | { type: "heading"; id: string; label: string };

export interface ActionMenuProps {
  /** Contents of the trigger button. */
  trigger: ReactNode;
  /** Accessible name for the trigger. */
  label: string;
  items: ActionMenuItem[];
  align?: "start" | "end";
  triggerClassName?: string;
  menuClassName?: string;
  /** Open below (default) or above the trigger (sidebar footer). */
  side?: "bottom" | "top";
  /** Stretch the wrapper to the trigger's container width. */
  block?: boolean;
}

/** Popover menu: Enter/Space/ArrowDown open, arrows move, Escape/Tab/outside-click close. */
export function ActionMenu({ trigger, label, items, align = "end", triggerClassName, menuClassName, side = "bottom", block }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const actionable = items.map((it, i) => ((it.type ?? "item") === "item" && !("disabled" in it && it.disabled) ? i : -1)).filter((i) => i >= 0);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  useEffect(() => {
    if (open && active >= 0) itemRefs.current[active]?.focus();
  }, [open, active]);

  function openMenu(focus: "first" | "last" = "first") {
    setOpen(true);
    setActive(focus === "first" ? (actionable[0] ?? -1) : (actionable.at(-1) ?? -1));
  }

  function close(refocus = true) {
    setOpen(false);
    setActive(-1);
    if (refocus) triggerRef.current?.focus();
  }

  function onMenuKey(e: KeyboardEvent) {
    const pos = actionable.indexOf(active);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(actionable[(pos + 1) % actionable.length] ?? -1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(actionable[(pos - 1 + actionable.length) % actionable.length] ?? -1);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(actionable[0] ?? -1);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(actionable.at(-1) ?? -1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      close(false);
    }
  }

  return (
    <div ref={wrapRef} className={cx("relative", block ? "block w-full" : "inline-block")}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            openMenu("first");
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            openMenu("last");
          }
        }}
        className={triggerClassName}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          className={cx(
            "absolute z-40 min-w-[232px] max-w-[min(320px,calc(100vw-32px))] rounded-[14px] border border-glass-border bg-glass-strong p-1.5 backdrop-blur-xl",
            side === "top" ? "bottom-full mb-2" : "mt-1.5",
            "shadow-pop",
            align === "end" ? "right-0" : "left-0",
            menuClassName,
          )}
          style={{ animation: "hb-pop 140ms var(--ease-out-quart)" }}
        >
          {items.map((it, i) => {
            if (it.type === "separator") return <div key={it.id} role="separator" className="mx-1 my-1.5 border-t border-rule" />;
            if (it.type === "heading")
              return (
                <div key={it.id} role="presentation" className="eyebrow px-2.5 pb-1 pt-2">
                  {it.label}
                </div>
              );
            return (
              <button
                key={it.id}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role={it.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={it.checked}
                tabIndex={active === i ? 0 : -1}
                disabled={it.disabled}
                onMouseEnter={() => !it.disabled && setActive(i)}
                onClick={() => {
                  close();
                  it.onSelect();
                }}
                className={cx(
                  "flex min-h-10 w-full items-start gap-3 rounded-[9px] px-2.5 py-2 text-left text-[14px] outline-none disabled:opacity-40",
                  active === i && "bg-accent-soft",
                  it.destructive ? "text-neg" : "text-ink",
                )}
              >
                {it.icon && <span className="mt-0.5 shrink-0 text-ink-3">{it.icon}</span>}
                <span className="min-w-0">
                  <span className="block leading-snug">{it.label}</span>
                  {it.description && <span className="block text-[12px] leading-snug text-ink-3">{it.description}</span>}
                </span>
                {it.checked && (
                  <span aria-hidden className="ml-auto mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent shadow-[0_0_8px_var(--accent-glow)]" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
