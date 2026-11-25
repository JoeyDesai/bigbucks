"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, ChevronLeft, ChevronRight, Lock, Settings } from "lucide-react";
import { cx } from "@/lib/cx";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { useLastAppPage } from "@/components/shell/LastAppPage";
import { SECTION_ICONS } from "./sectionIcons";

function Item({ href, label, Icon, active }: { href: string; label: string; Icon: typeof Settings; active: boolean }) {
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={cx("flex min-h-10 items-center gap-2.5 rounded-[10px] px-2.5 text-[14px] transition-colors", active ? "bg-accent-soft font-semibold text-accent" : "text-ink-2 hover:bg-paper-hover hover:text-ink")}
      >
        <Icon size={16} strokeWidth={1.9} aria-hidden className="shrink-0" />
        <span className="truncate">{label}</span>
      </Link>
    </li>
  );
}

/**
 * Settings navigation. Desktop: a column beside every Settings page with a way back to the app and every
 * section. Phone: a bar with "‹ Settings" inside a section and "Done" to go back to the app.
 */
export function SettingsNav({ admin }: { admin: boolean }) {
  const pathname = usePathname();
  const back = useLastAppPage();
  const inSection = pathname !== "/settings";
  const sections = SETTINGS_SECTIONS.filter((s) => admin || !s.admin);
  return (
    <>
      <div className="flex min-h-12 items-center justify-between px-2 pt-2 lg:hidden" data-testid="settings-bar">
        {inSection ? (
          <Link href="/settings" className="inline-flex min-h-11 items-center gap-1 px-2 text-[15px] font-semibold text-accent">
            <ChevronLeft size={18} strokeWidth={2} aria-hidden /> Settings
          </Link>
        ) : (
          <span />
        )}
        <Link href={back.href} className="inline-flex min-h-11 items-center rounded-full px-3 text-[15px] font-semibold text-accent" data-testid="settings-done">
          Done
        </Link>
      </div>

      <nav aria-label="Settings" className="hidden lg:block">
        <div className="sticky top-0 max-h-dvh overflow-y-auto border-r border-rule px-3 pb-8 pt-6">
          <Link href={back.href} className="mb-5 inline-flex min-h-10 items-center gap-1 rounded-full border border-rule-strong pl-2 pr-3.5 text-[13.5px] font-semibold text-ink-2 hover:border-accent/60 hover:text-ink" data-testid="settings-exit">
            <ChevronLeft size={16} strokeWidth={2} aria-hidden /> Back to {back.label}
          </Link>
          <ul className="space-y-0.5">
            <Item href="/settings" label="Overview" Icon={Settings} active={!inSection} />
            {sections
              .filter((s) => !s.admin)
              .map((s) => (
                <Item key={s.slug} href={`/settings/${s.slug}`} label={s.title} Icon={SECTION_ICONS[s.slug] ?? ChevronRight} active={pathname.startsWith(`/settings/${s.slug}`)} />
              ))}
          </ul>
          {admin && (
            <>
              <div className="mb-1 mt-5 flex items-center gap-1.5 px-2.5 text-[11.5px] font-bold uppercase tracking-[0.06em] text-ink-3">
                <Lock size={11} strokeWidth={2.4} aria-hidden /> Admin
              </div>
              <ul className="space-y-0.5">
                {sections
                  .filter((s) => s.admin)
                  .map((s) => (
                    <Item key={s.slug} href={`/settings/${s.slug}`} label={s.title} Icon={SECTION_ICONS[s.slug] ?? ChevronRight} active={pathname.startsWith(`/settings/${s.slug}`)} />
                  ))}
              </ul>
            </>
          )}
          <ul className="mt-5 border-t border-rule pt-4">
            <Item href="/guide" label="How Big Bucks works" Icon={BookOpen} active={false} />
          </ul>
        </div>
      </nav>
    </>
  );
}
