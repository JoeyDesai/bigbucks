"use client";
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cx } from "@/lib/cx";

export const INPUT = "block h-11 w-full rounded-lg border border-rule-strong bg-paper-raised px-3 text-[15px] text-ink outline-none placeholder:text-ink-3 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] disabled:opacity-60";

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={cx("block", className)}>
      <label htmlFor={id} className="eyebrow mb-1.5 block">
        {label}
      </label>
      {children(id)}
      {hint && <p className="mt-1 text-[12px] text-ink-3">{hint}</p>}
    </div>
  );
}

export function TextField({ label, hint, className, inputClassName, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode; inputClassName?: string }) {
  return <Field label={label} hint={hint} className={className}>{(id) => <input id={id} {...rest} className={cx(INPUT, rest.inputMode === "decimal" || rest.type === "number" ? "num" : undefined, inputClassName)} />}</Field>;
}

export function TextArea({ label, hint, className, mono, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: ReactNode; hint?: ReactNode; mono?: boolean }) {
  return <Field label={label} hint={hint} className={className}>{(id) => <textarea id={id} {...rest} className={cx(INPUT, "h-auto min-h-24 py-2.5 leading-snug", mono && "font-mono text-[13px]")} />}</Field>;
}

export function SelectField({ label, hint, className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <Field label={label} hint={hint} className={className}>
      {(id) => (
        <select id={id} {...rest} className={INPUT}>
          {children}
        </select>
      )}
    </Field>
  );
}

/** Hairline switch row: label + description on the left, a square-ish toggle on the right. */
export function ToggleRow({ label, description, checked, onChange, disabled }: { label: ReactNode; description?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex min-h-[56px] items-center gap-4 border-b border-rule py-2.5">
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <span className="block text-[15px] text-ink">{label}</span>
        {description && <span className="block text-[12px] text-ink-3">{description}</span>}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx("relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-50", checked ? "border-accent bg-accent" : "border-rule-strong bg-paper-sunken")}
      >
        <span aria-hidden className={cx("absolute top-[3px] h-4 w-4 rounded-full transition-[left] duration-150", checked ? "left-[22px] bg-paper" : "left-[3px] bg-ink-3")} />
      </button>
    </div>
  );
}

/** Inline result line under a form ("Saved." / an error). */
export function FormStatus({ result }: { result: { ok: true } | { ok: false; error: string } | null | undefined }) {
  if (!result) return null;
  return result.ok ? (
    <p role="status" className="text-[13px] text-pos">
      Saved.
    </p>
  ) : (
    <p role="alert" className="text-[13px] text-neg">
      {result.error}
    </p>
  );
}
