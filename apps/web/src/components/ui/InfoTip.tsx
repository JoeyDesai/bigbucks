"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { cx } from "@/lib/cx";

/**
 * Small "ⓘ" explainer: shows on hover, focus or tap; Escape or a tap elsewhere closes it.
 * The text is also the button's description, so screen readers hear it.
 */
export function InfoTip({ label, children, className, size = 15, align = "center" }: { label: string; children: ReactNode; className?: string; size?: number; align?: "center" | "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span ref={ref} className={cx("relative inline-flex", className)} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full opacity-70 hover:opacity-100"
      >
        <Info size={size} strokeWidth={2} aria-hidden />
      </button>
      <span
        id={id}
        role="tooltip"
        className={cx(
          "absolute top-full z-50 mt-1.5 w-[260px] rounded-lg bg-nav px-3 py-2.5 text-left text-[13px] font-normal normal-case leading-snug tracking-normal text-white shadow-pop",
          align === "center" && "left-1/2 -translate-x-1/2",
          align === "start" && "left-0",
          align === "end" && "right-0",
          open ? "block" : "hidden",
        )}
      >
        {children}
      </span>
    </span>
  );
}
