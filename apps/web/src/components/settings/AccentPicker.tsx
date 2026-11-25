"use client";
import { useRef, useState, useTransition } from "react";
import { Check, Pipette } from "lucide-react";
import { useRouter } from "next/navigation";
import { isCustomAccent } from "@homebase/shared";
import { cx } from "@/lib/cx";
import { applyAccentToDocument } from "@/lib/accent";
import { setMyAccentAction } from "@/server/settings/actions/household";
import { useToast } from "@/components/ui/Toast";

export const ACCENTS = [
  { id: "gold", label: "Gold", color: "#C9A24A" },
  { id: "blue", label: "Blue", color: "#3d6bff" },
  { id: "pink", label: "Pink", color: "#e5457d" },
  { id: "green", label: "Green", color: "#12a165" },
  { id: "purple", label: "Purple", color: "#7357ff" },
  { id: "orange", label: "Orange", color: "#f0661d" },
  { id: "teal", label: "Teal", color: "#0aa0b4" },
] as const;
export type NamedAccentId = (typeof ACCENTS)[number]["id"];
/** A named accent or a custom "#rrggbb". */
export type AccentId = NamedAccentId | `#${string}`;

/**
 * Seven swatches plus Custom (a color input). The choice applies at once and is saved to your profile:
 * each person has their own, and it drives the bucket bars, glow, focus rings and highlights.
 */
export function AccentPicker({ initial }: { initial: AccentId }) {
  const [value, setValue] = useState<AccentId>(initial);
  const [, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const colorRef = useRef<HTMLInputElement>(null);
  const custom = isCustomAccent(value) ? value : null;
  const save = (id: AccentId) => {
    const prev = value;
    setValue(id);
    applyAccentToDocument(id);
    start(async () => {
      const r = await setMyAccentAction(id);
      if (!r.ok) {
        setValue(prev);
        applyAccentToDocument(prev);
        toast.show({ message: r.error, tone: "error" });
      } else router.refresh();
    });
  };
  const swatch = (on: boolean) => cx("relative flex h-11 w-11 items-center justify-center rounded-full ring-offset-2 ring-offset-paper transition-transform hover:scale-105", on && "ring-2 ring-ink");
  return (
    <div role="radiogroup" aria-label="Accent color" className="flex flex-wrap items-center gap-3">
      {ACCENTS.map((a) => {
        const on = a.id === value;
        return (
          <button key={a.id} type="button" role="radio" aria-checked={on} aria-label={a.label} title={a.label} onClick={() => save(a.id)} className={swatch(on)} style={{ background: a.color, boxShadow: on ? `0 0 18px -2px ${a.color}` : undefined }}>
            {on && <Check size={20} strokeWidth={3} className="text-white" aria-hidden />}
          </button>
        );
      })}
      <button
        type="button"
        role="radio"
        aria-checked={!!custom}
        aria-label="Custom color"
        title="Custom color"
        onClick={() => colorRef.current?.click()}
        className={swatch(!!custom)}
        style={custom ? { background: custom, boxShadow: `0 0 18px -2px ${custom}` } : { background: "conic-gradient(from 180deg, #ff5e7e, #ffb547, #45e09a, #4fdfee, #6f9bff, #a993ff, #ff5e7e)" }}
      >
        {custom ? <Check size={20} strokeWidth={3} className="text-white" aria-hidden /> : <Pipette size={17} strokeWidth={2.2} className="text-white drop-shadow" aria-hidden />}
      </button>
      <input
        ref={colorRef}
        type="color"
        aria-label="Pick a custom accent color"
        className="sr-only"
        defaultValue={custom ?? "#3d6bff"}
        onChange={(e) => applyAccentToDocument(e.target.value.toLowerCase())}
        onBlur={(e) => {
          const v = e.target.value.toLowerCase() as `#${string}`;
          if (v !== value) save(v);
        }}
      />
    </div>
  );
}
