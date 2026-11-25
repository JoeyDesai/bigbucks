import type { ReactNode } from "react";
import { SettingsNav } from "@/components/settings/SettingsNav";
import { isAdmin, requireUser } from "@/server/auth";

/** Every Settings page: the settings navigation (side column on desktop, a top bar on phones) beside the page. */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const cu = await requireUser();
  return (
    <div className="lg:grid lg:min-h-dvh lg:grid-cols-[236px_minmax(0,1fr)]">
      <SettingsNav admin={isAdmin(cu)} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
