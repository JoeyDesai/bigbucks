"use client";
import { useRef, useState, useTransition } from "react";
import { Target } from "lucide-react";
import { formatMilli } from "@homebase/shared";
import { parseGoalText } from "@/lib/bucket-display";
import { cx } from "@/lib/cx";
import { setBucketGoalAction } from "@/server/actions/glow";
import { undoAction } from "@/server/actions/budget";
import { useToast } from "@/components/ui/Toast";

/**
 * Goal amount field. `inline` = the subtle "Set a goal" affordance on a goal-less row: it opens into a
 * small $ field, Enter saves a monthly "set aside" goal (core editTarget), Escape cancels.
 */
export function GoalInline({ categoryId, name, month, initial, inline = true, keepType, onSaved, className }: {
  categoryId: string;
  name: string;
  month: string;
  initial?: bigint | null;
  inline?: boolean;
  keepType?: "need_set_aside" | "need_refill" | "monthly_builder";
  onSaved?: () => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(!inline);
  const [text, setText] = useState(initial ? formatMilli(initial).replace("$", "") : "");
  const [error, setError] = useState(false);
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  function save() {
    const v = parseGoalText(text);
    if (v === null) {
      setError(true);
      inputRef.current?.focus();
      return;
    }
    if (initial && v === initial) {
      if (inline) setEditing(false);
      return;
    }
    start(async () => {
      const r = await setBucketGoalAction({ categoryId, month, amount: v, keepType });
      if (!r.ok) {
        toast.show({ message: r.error, tone: "error" });
        return;
      }
      if (inline) setEditing(false);
      onSaved?.();
      toast.show({
        message: `${name}: ${formatMilli(v, { cents: false })} a month`,
        action: r.operationId
          ? {
              label: "Undo",
              onAction: () => void undoAction(r.operationId!),
            }
          : undefined,
      });
    });
  }

  if (!editing)
    return (
      <button
        type="button"
        onClick={() => {
          setEditing(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        className={cx("inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium text-ink-3 transition-colors hover:bg-accent-soft hover:text-accent", className)}
        aria-label={`Set a goal for ${name}`}
      >
        <Target size={14} strokeWidth={2} aria-hidden /> Set a goal
      </button>
    );

  return (
    <form
      className={cx("inline-flex items-center gap-1.5", className)}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className={cx("flex h-9 items-center rounded-[10px] border bg-paper px-2.5 transition-shadow focus-within:shadow-[0_0_0_3px_var(--accent-soft)]", error ? "border-over" : "border-rule-strong focus-within:border-accent")}>
        <span className="text-[14px] text-ink-3">$</span>
        <input
          ref={inputRef}
          autoFocus={inline}
          inputMode="decimal"
          aria-label={`Monthly goal for ${name}`}
          value={text}
          placeholder="0"
          onChange={(e) => {
            setText(e.target.value);
            setError(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && inline) {
              e.stopPropagation();
              setEditing(false);
            }
          }}
          className="num w-[84px] bg-transparent pl-1 text-[15px] text-ink outline-none"
        />
      </label>
      <button type="submit" disabled={pending} className="h-9 rounded-[10px] bg-accent px-3 text-[13px] font-semibold text-accent-contrast shadow-[0_4px_14px_-6px_var(--accent-glow)] disabled:opacity-50">
        {pending ? "Saving" : inline ? "Save" : "Save goal"}
      </button>
    </form>
  );
}
