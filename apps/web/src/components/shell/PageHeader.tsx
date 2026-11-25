import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { UserMenu } from "./UserMenu";

export interface PageHeaderProps {
  title: ReactNode;
  /** Small line above the title. */
  eyebrow?: ReactNode;
  /** Right side controls (before the avatar on phones). */
  actions?: ReactNode;
  /** Replaces the title area entirely (e.g. the Plan month switcher). */
  children?: ReactNode;
  className?: string;
  /** Hide the phone avatar (screens with their own top bar). */
  noAvatar?: boolean;
}

/** Page header: bold title, actions, and the accent avatar (→ Settings) on phones. */
export function PageHeader({ title, eyebrow, actions, children, className, noAvatar }: PageHeaderProps) {
  return (
    <header className={cx("flex items-center gap-2 px-4 pb-2 pt-3 lg:px-8 lg:pb-4 lg:pt-6", className)}>
      <div className="min-w-0 flex-1">
        {children ? (
          <>
            <h1 className="sr-only">{title}</h1>
            {children}
          </>
        ) : (
          <>
            {eyebrow && <div className="mb-0.5 text-[13px] font-medium text-ink-3">{eyebrow}</div>}
            <h1 className="display truncate text-[26px] leading-[1.15] text-ink lg:text-[30px]">{title}</h1>
          </>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      {!noAvatar && (
        <div className="-mr-2 lg:hidden">
          <UserMenu />
        </div>
      )}
    </header>
  );
}
