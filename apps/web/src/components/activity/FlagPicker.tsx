"use client";
import { X } from "lucide-react";
import { cx } from "@/lib/cx";

export type FlagColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple";
export const FLAG_COLORS: Record<FlagColor, string> = {
  red: "#c0392b",
  orange: "#d2691e",
  yellow: "#c99a16",
  green: "#2f7d55",
  blue: "#2c4a78",
  purple: "#6c5a8c",
};

/** Small square flag marker (no pill). */
export function FlagMark({ flag, className }: { flag: FlagColor; className?: string }) {
  return <span aria-label={`${flag} flag`} title={`${flag} flag`} className={cx("inline-block h-2 w-2 shrink-0", className)} style={{ background: FLAG_COLORS[flag] }} />;
}

/** Flag choice: six colored squares plus "none". Radio-group semantics. */
export function FlagPicker({ value, onChange }: { value: FlagColor | null; onChange: (f: FlagColor | null) => void }) {
  return (
    <div role="radiogroup" aria-label="Flag" className="flex items-center gap-1">
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        aria-label="No flag"
        onClick={() => onChange(null)}
        className={cx("inline-flex h-11 w-11 items-center justify-center rounded-xs border", value === null ? "border-accent" : "border-transparent text-ink-3")}
      >
        <X size={14} strokeWidth={1.75} />
      </button>
      {(Object.keys(FLAG_COLORS) as FlagColor[]).map((f) => (
        <button
          key={f}
          type="button"
          role="radio"
          aria-checked={value === f}
          aria-label={`${f} flag`}
          onClick={() => onChange(f)}
          className={cx("inline-flex h-11 w-11 items-center justify-center rounded-xs border", value === f ? "border-accent" : "border-transparent")}
        >
          <span className="h-3.5 w-3.5" style={{ background: FLAG_COLORS[f] }} />
        </button>
      ))}
    </div>
  );
}
