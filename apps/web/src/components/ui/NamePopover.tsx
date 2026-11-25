"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "@/lib/cx";
import { Button } from "./Button";

/**
 * A trigger that opens a small popover with one text field and OK / Cancel (YNAB's "+ Category Group",
 * "+ category" in a group row). `onSubmit` resolves to an error message, or null when it worked.
 */
export function NamePopover({ trigger, label, placeholder, onSubmit, triggerClassName, align = "start" }: { trigger: ReactNode; label: string; placeholder?: string; onSubmit: (name: string) => Promise<string | null>; triggerClassName?: string; align?: "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);
  const submit = async () => {
    if (!name.trim()) return setError("Enter a name");
    setBusy(true);
    const err = await onSubmit(name.trim());
    setBusy(false);
    if (err) return setError(err);
    setName("");
    setError(null);
    setOpen(false);
  };
  return (
    <div ref={ref} className="relative inline-block">
      <button type="button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)} className={triggerClassName}>
        {trigger}
      </button>
      {open && (
        <div role="dialog" aria-label={label} className={cx("absolute top-full z-40 mt-1.5 w-[280px] rounded-xl border border-rule bg-paper-raised p-3 shadow-pop", align === "end" ? "right-0" : "left-0")} style={{ animation: "hb-pop 140ms var(--ease-out-quart)" }}>
          <label className="block text-[13px] font-semibold text-ink">
            {label}
            <input
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                } else if (e.key === "Escape") setOpen(false);
              }}
              placeholder={placeholder}
              className="mt-1.5 h-10 w-full rounded-lg border-2 border-accent bg-paper-raised px-3 text-[14px] font-normal outline-none"
            />
          </label>
          {error && <p role="alert" className="mt-1 text-[12px] text-neg">{error}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" busy={busy} onClick={() => void submit()}>
              OK
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
