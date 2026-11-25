"use client";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { formatMilli } from "@homebase/shared";
import { isAmountExpression, resolveAmountText } from "@/lib/amount";
import { cx } from "@/lib/cx";

export interface AmountInputProps {
  /** Current value (bigint milli). */
  value: bigint;
  /** Called with the evaluated value on Enter or blur. Not called if unchanged or invalid. */
  onCommit: (next: bigint) => void;
  onCancel?: () => void;
  /** Accessible label (visually hidden if `hideLabel`). */
  label: string;
  hideLabel?: boolean;
  /** Start in edit mode and focus. */
  autoFocus?: boolean;
  /** Display-only mode until tapped (the Assigned cell). Default true. */
  tapToEdit?: boolean;
  className?: string;
  /** Allow negative results (default true). */
  allowNegative?: boolean;
  placeholder?: string;
  /** "sm": 32px tall (desktop table cells). Default 44px. */
  size?: "sm" | "md";
  /** Show the tap-to-edit value inside a visible field outline (sheets / inspector). */
  boxed?: boolean;
  /** Called after Enter commits a valid value (also when unchanged): e.g. submit the form around it. */
  onEnter?: (value: bigint) => void;
  /** Extra classes for the input itself. */
  inputClassName?: string;
  /** Always-editable field: show an empty field (the placeholder) instead of "0.00" when the value is 0. */
  blankZero?: boolean;
}

/** Editable display string: "1234.5" → "1,234.50" without the $ sign. */
function editText(v: bigint): string {
  return formatMilli(v, { sign: "auto" }).replace("$", "");
}

/**
 * Money input with the Assigned-cell mini-language (spec §12.1):
 * `200` / `=200` set · `+50` add · `-25` subtract · `*2` `/4` scale · `50*2` arithmetic.
 * Enter or blur commits, Escape cancels. Uses inputmode="decimal".
 */
export function AmountInput({
  value,
  onCommit,
  onCancel,
  label,
  hideLabel = true,
  autoFocus,
  tapToEdit = true,
  className,
  allowNegative = true,
  placeholder,
  size = "md",
  boxed,
  onEnter,
  inputClassName,
  blankZero,
}: AmountInputProps) {
  const id = useId();
  const [editing, setEditing] = useState(!tapToEdit || !!autoFocus);
  const shownText = (v: bigint) => (blankZero && v === 0n ? "" : editText(v));
  const [text, setText] = useState(() => (tapToEdit ? "" : shownText(value)));
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!tapToEdit && document.activeElement !== inputRef.current) setText(blankZero && value === 0n ? "" : editText(value));
  }, [value, tapToEdit, blankZero]);

  useEffect(() => {
    if (editing && tapToEdit) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, tapToEdit]);

  const preview = (): bigint | null => resolveAmountText(text, value, { signedAbsolute: !tapToEdit });

  /** Returns true when the value was accepted. `cancelled` skips the blur that follows Enter/Escape. */
  function commit(): boolean {
    if (cancelled.current) {
      cancelled.current = false;
      return false;
    }
    return commitValue() !== null;
  }

  /** Validate and commit; returns the committed value or null. */
  function commitValue(): bigint | null {
    const next = preview();
    if (next === null) {
      setError("Use a number, or +50, -25, =200, *2");
      inputRef.current?.focus();
      return null;
    }
    if (!allowNegative && next < 0n) {
      setError("Amount can't be negative");
      inputRef.current?.focus();
      return null;
    }
    setError(null);
    if (tapToEdit) setEditing(false);
    if (next !== value) onCommit(next);
    // Show the result in an always-editable field, so a later blur doesn't re-apply "+50"/"-10".
    if (!tapToEdit) setText(shownText(next));
    return next;
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      cancelled.current = false;
      const v = commitValue();
      if (v !== null && tapToEdit) {
        cancelled.current = true;
        inputRef.current?.blur();
        cancelled.current = false;
      }
      if (v !== null) onEnter?.(v);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelled.current = true;
      setError(null);
      setText(tapToEdit ? "" : shownText(value));
      if (tapToEdit) setEditing(false);
      onCancel?.();
      inputRef.current?.blur();
    }
  }

  const p = editing ? preview() : null;
  const showPreview = editing && p !== null && !error && isAmountExpression(text);

  if (tapToEdit && !editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setText("");
          setEditing(true);
        }}
        aria-label={`${label}: ${formatMilli(value)}. Edit`}
        className={cx(
          "num rounded-md border px-1.5 text-right text-ink-2 transition-colors hover:border-rule-strong hover:bg-paper-raised hover:text-ink",
          boxed ? "min-w-[132px] border-rule-strong bg-paper-raised px-3 text-ink" : "-mx-1.5 border-transparent",
          size === "sm" ? "min-h-8 lg:min-h-8" : "min-h-11",
          value === 0n && "text-ink-3",
          className,
        )}
      >
        {formatMilli(value)}
      </button>
    );
  }

  return (
    <span className={cx("relative inline-flex flex-col items-end", className)}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "mb-1 self-start text-[13px] text-ink-2"}>
        {label}
      </label>
      <input
        ref={inputRef}
        id={id}
        inputMode="decimal"
        enterKeyHint="done"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        autoFocus={autoFocus}
        value={text}
        placeholder={placeholder ?? (tapToEdit ? editText(value) : "0.00")}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onBlur={() => void commit()}
        onKeyDown={onKeyDown}
        className={cx(
          "num w-full min-w-[96px] rounded-md border-2 bg-paper-raised px-2 text-right font-medium text-ink outline-none transition-colors placeholder:text-ink-3",
          size === "sm" ? "h-8" : "h-11",
          error ? "border-neg" : "border-accent shadow-[0_0_0_3px_var(--accent-soft)]",
          inputClassName,
        )}
      />
      {showPreview && p !== null && (
        <span className="num pointer-events-none absolute -bottom-5 right-0 text-[11px] text-ink-3" aria-live="polite">
          = {formatMilli(p)}
        </span>
      )}
      {error && (
        <span id={`${id}-err`} role="alert" className="absolute -bottom-5 right-0 whitespace-nowrap text-[11px] text-neg">
          {error}
        </span>
      )}
    </span>
  );
}
