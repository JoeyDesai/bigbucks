import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

export interface EmptyStateProps {
  /** A thin-stroke lucide icon or small inline SVG. */
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Friendly empty state: icon in an accent circle, bold title, one or two lines, optional action. */
export function EmptyState({ icon, title, children, action, className }: EmptyStateProps) {
  return (
    <div className={cx("flex flex-col items-start gap-2.5 py-10", className)}>
      {icon && <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-soft text-accent">{icon}</div>}
      <h3 className="text-[18px] font-bold leading-tight text-ink">{title}</h3>
      {children && <div className="max-w-[46ch] text-[14px] text-ink-2">{children}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
