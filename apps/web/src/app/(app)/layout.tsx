import type { ReactNode } from "react";
import { today as localToday } from "@homebase/shared";
import { AppShell } from "@/components/shell/AppShell";
import { requireUser } from "@/server/auth";
import { loadAccounts } from "@/server/queries/transactions";
import { loadCashSpark, loadNeedsReviewCount } from "@/server/queries/glow";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { user, via } = await requireUser();
  const today = localToday();
  const { accounts } = await loadAccounts(today, { includeClosed: true });
  const review = await loadNeedsReviewCount();
  const spark = await loadCashSpark(today);
  return (
    <AppShell user={{ displayName: user.displayName, role: user.role, via, email: user.tailscaleLogin, accent: user.accent ?? null }} accounts={accounts} badges={{ "/transactions": review }} spark={spark} demo={via === "demo"}>
      {children}
    </AppShell>
  );
}
