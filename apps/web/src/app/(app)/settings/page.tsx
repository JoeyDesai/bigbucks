import Link from "next/link";
import { BookOpen, ChevronRight, Lock } from "lucide-react";
import { SECTION_ICONS as ICONS } from "@/components/settings/sectionIcons";
import { SETTINGS_SECTIONS } from "@/lib/settings-sections";
import { PageHeader } from "@/components/shell/PageHeader";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { AccentPicker, type AccentId } from "@/components/settings/AccentPicker";
import { Button } from "@/components/ui/Button";
import { isAdmin, requireUser } from "@/server/auth";
import { signOutAction } from "@/server/actions";
import { getThemePref } from "@/server/theme";
import { initials } from "@/lib/format";

export const metadata = { title: "Settings" };


function SectionList({ items }: { items: typeof SETTINGS_SECTIONS }) {
  return (
    <ul className="card overflow-hidden">
      {items.map((s) => {
        const Icon = ICONS[s.slug] ?? ChevronRight;
        return (
          <li key={s.slug} className="border-t border-rule first:border-t-0">
            <Link href={`/settings/${s.slug}`} className="group flex min-h-[64px] items-center gap-3 px-4 py-2.5 hover:bg-paper-hover">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
                <Icon size={18} strokeWidth={2} aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold text-ink">{s.title}</span>
                <span className="block truncate text-[12.5px] text-ink-3">{s.blurb}</span>
              </span>
              <ChevronRight size={17} strokeWidth={2} aria-hidden className="text-ink-3 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

const VIA = { access: "Signed in with your email", tailscale: "Signed in by Tailscale identity", session: "Signed in with your password", dev: "Development bypass", demo: "Demo visitor" } as const;
const H2 = "mb-2 px-1 text-[13px] font-bold uppercase tracking-[0.05em] text-ink-3";

export default async function SettingsPage() {
  const cu = await requireUser();
  const admin = isAdmin(cu);
  const theme = await getThemePref();
  const household = SETTINGS_SECTIONS.filter((s) => !s.admin);
  const adminOnly = SETTINGS_SECTIONS.filter((s) => s.admin);

  return (
    <div className="min-h-dvh bg-paper-sunken pb-10">
      <PageHeader title="Settings" />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 px-4 lg:grid-cols-2 lg:px-8">
        <div className="space-y-8">
          <section aria-labelledby="you-h">
            <h2 id="you-h" className={H2}>
              You
            </h2>
            <div className="card p-4">
              <div className="flex items-center gap-3">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent text-[18px] font-bold text-accent-contrast">{initials(cu.user.displayName)}</span>
                <div className="min-w-0">
                  <div className="text-[19px] font-bold text-ink">{cu.user.displayName}</div>
                  <div className="text-[13px] text-ink-3">
                    {cu.user.role === "admin" ? "Admin" : "Member"} · {VIA[cu.via]}
                  </div>
                </div>
                {cu.via === "access" && (
                  <form action="/cdn-cgi/access/logout" method="get" className="ml-auto">
                    <Button type="submit" size="sm">
                      Sign out
                    </Button>
                  </form>
                )}
                {cu.via === "session" && (
                  <form action={signOutAction} className="ml-auto">
                    <Button type="submit" size="sm">
                      Sign out
                    </Button>
                  </form>
                )}
              </div>
              <div className="mt-5">
                <div className="text-[14px] font-semibold text-ink">Your color</div>
                <p className="mb-3 text-[12.5px] text-ink-3">Used for highlights, buttons and links when you&rsquo;re signed in. Money colors stay the same for everyone.</p>
                <AccentPicker initial={(cu.user.accent ?? "gold") as AccentId} />
              </div>
            </div>
          </section>
          <section aria-labelledby="appearance-h">
            <h2 id="appearance-h" className={H2}>
              Appearance
            </h2>
            <div className="card p-4">
              <ThemeToggle initial={theme} />
              <p className="mt-2 text-[12.5px] text-ink-3">Light is the default. Dark is easier on the eyes at night; Match system follows your phone.</p>
            </div>
          </section>
          <Link href="/guide" className="card flex items-center gap-3 p-4 hover:bg-paper-hover" data-testid="settings-guide">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <BookOpen size={18} strokeWidth={2} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold text-ink">How Big Bucks works</span>
              <span className="block truncate text-[12.5px] text-ink-3">Buckets, savings, Ready to save, shortcuts and more.</span>
            </span>
            <ChevronRight size={17} strokeWidth={2} aria-hidden className="text-ink-3" />
          </Link>
          <section aria-labelledby="household-h">
            <h2 id="household-h" className={H2}>
              Household
            </h2>
            <SectionList items={household} />
          </section>
        </div>
        {admin && (
          <section aria-labelledby="admin-h">
            <h2 id="admin-h" className={`${H2} flex items-center gap-1.5`}>
              <Lock size={12} strokeWidth={2.4} aria-hidden /> Admin only
            </h2>
            <SectionList items={adminOnly} />
          </section>
        )}
      </div>
    </div>
  );
}
