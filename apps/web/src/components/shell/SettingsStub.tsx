import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Lock } from "lucide-react";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { PageHeader } from "./PageHeader";

/** Placeholder for a Settings section until its data pass lands. */
export function SettingsStub({ slug }: { slug: string }) {
  const s = SETTINGS_SECTIONS.find((x) => x.slug === slug);
  if (!s) notFound();
  return (
    <>
      <div className="px-2 pt-2 lg:px-6 lg:pt-6">
        <Link href="/settings" className="inline-flex min-h-11 items-center gap-1 px-2 text-[14px] font-semibold text-accent hover:text-accent-hover">
          <ChevronLeft size={16} strokeWidth={1.75} aria-hidden /> Settings
        </Link>
      </div>
      <PageHeader
        title={s.title}
        eyebrow={
          s.admin ? (
            <span className="inline-flex items-center gap-1">
              <Lock size={11} strokeWidth={2} aria-hidden /> Admin only
            </span>
          ) : undefined
        }
        className="lg:pt-2"
      />
      <div className="px-4 lg:max-w-[640px] lg:px-8">
        <p className="text-[15px] text-ink-2">{s.blurb}</p>
        <h2 className="eyebrow mb-2 mt-8">Coming in this section</h2>
        <ul className="border-t border-rule">
          {s.planned.map((p) => (
            <li key={p} className="flex items-center gap-3 border-b border-rule py-3 text-[14px] text-ink">
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 bg-rule-strong" />
              {p}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
