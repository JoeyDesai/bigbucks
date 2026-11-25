import { Suspense, type ReactNode } from "react";
import type { AccountVM } from "@/lib/view-models";
import { ShortcutSheet } from "@/components/glow/ShortcutSheet";
import { BottomTabs } from "./BottomTabs";
import { InstallHint } from "./InstallHint";
import { RememberAppPage } from "./LastAppPage";
import { Sidebar } from "./Sidebar";
import { UserProvider, type ShellUser } from "./UserContext";

export interface AppShellProps {
  user: ShellUser;
  accounts: AccountVM[];
  /** Counts shown on nav items, keyed by href (needs-review → "/transactions"). */
  badges?: Record<string, number>;
  /** Σ on-budget balances per day for the sidebar sparkline. */
  spark?: bigint[];
  /** Public demo: a strip at the top says the data is made up. */
  demo?: boolean;
  children: ReactNode;
}

/** Signed-in chrome: frosted desktop sidebar, phone tab bar, safe-area padding, install hint, shortcut sheet. */
export function AppShell({ user, accounts, badges, spark, demo, children }: AppShellProps) {
  return (
    <UserProvider user={user}>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-md focus:bg-paper focus:px-3 focus:py-2">
        Skip to content
      </a>
      <Sidebar accounts={accounts} badges={badges} spark={spark} />
      <div className="hb-content relative z-[1] min-h-dvh pl-[var(--safe-left)] pr-[var(--safe-right)] lg:pl-[var(--sidebar-w)] lg:pr-0">
        <main id="main" className="w-full pt-[var(--safe-top)] pb-[calc(var(--tabbar-h)+var(--safe-bottom)+32px)] lg:pb-8">
          {demo && (
            <p className="border-b border-rule px-4 py-2 text-center text-[12.5px] text-ink-3" data-testid="demo-strip">
              <span className="font-semibold text-ink-2">Demo.</span> Everyone and every dollar here is made up. Try anything; it all resets overnight.
            </p>
          )}
          <InstallHint />
          {children}
        </main>
      </div>
      <BottomTabs badges={badges} />
      <ShortcutSheet />
      <Suspense>
        <RememberAppPage />
      </Suspense>
    </UserProvider>
  );
}
