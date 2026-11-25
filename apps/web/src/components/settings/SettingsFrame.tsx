import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { PageHeader } from "@/components/shell/PageHeader";
import { cx } from "@/lib/cx";

/** Shared chrome for a Settings section: title, optional admin marker, content column (navigation comes from the settings layout). */
export function SettingsFrame({ title, admin, intro, actions, children, wide }: { title: string; admin?: boolean; intro?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <>
      <PageHeader
        title={title}
        actions={actions}
        eyebrow={
          admin ? (
            <span className="inline-flex items-center gap-1">
              <Lock size={11} strokeWidth={2} aria-hidden /> Admin only
            </span>
          ) : undefined
        }
        className="lg:pt-6"
      />
      <div className={cx("px-4 pb-16 lg:px-8", wide ? "lg:max-w-[1040px]" : "lg:max-w-[720px]")}>
        {intro && <div className="mb-8 max-w-[62ch] text-[15px] text-ink-2">{intro}</div>}
        {children}
      </div>
    </>
  );
}

/** A titled block inside a Settings section. */
export function SettingsSection({ title, description, children, id, actions }: { title: string; description?: ReactNode; children: ReactNode; id?: string; actions?: ReactNode }) {
  return (
    <section aria-labelledby={id ? `${id}-h` : undefined} className="mb-12">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 id={id ? `${id}-h` : undefined} className="text-[18px] font-bold leading-tight text-ink">
            {title}
          </h2>
          {description && <p className="mt-1 max-w-[62ch] text-[13px] text-ink-3">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
