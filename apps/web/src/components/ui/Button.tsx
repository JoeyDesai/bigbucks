import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "@/lib/cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "positive";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  /** Shows a spinner and disables the button. */
  busy?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-contrast border border-accent hover:bg-accent-hover hover:border-accent-hover",
  secondary: "bg-paper-raised text-ink border border-rule-strong hover:bg-paper-hover hover:border-ink-3",
  ghost: "bg-transparent text-accent border border-transparent hover:bg-accent-soft",
  danger: "bg-paper-raised text-neg border border-neg/40 hover:border-neg hover:bg-neg-wash",
  positive: "bg-[var(--rta-pos-btn)] text-white border border-[var(--rta-pos-btn)] hover:opacity-90",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "min-h-9 px-3 text-[13px] gap-1.5",
  md: "min-h-11 px-4 text-[14px] gap-2",
};

/** Rounded button: accent primary, outlined secondary, accent-text ghost. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, busy, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex select-none items-center justify-center rounded-md font-semibold transition-[opacity,border-color,background-color,transform] duration-150 active:translate-y-px disabled:opacity-45",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {busy ? <Spinner /> : icon}
      {children}
    </button>
  );
});

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 rounded-full border-[1.5px] border-current border-r-transparent"
      style={{ width: size, height: size, animation: "hb-spin 0.7s linear infinite" }}
    />
  );
}

/** 44×44 icon-only button with an accessible label. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(
  function IconButton({ label, className, children, type = "button", ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        title={label}
        className={cx(
          "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-paper-sunken hover:text-ink disabled:opacity-40",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
