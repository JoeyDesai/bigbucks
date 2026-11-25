import { inArray } from "drizzle-orm";
import { listAccounts } from "@homebase/core";
import { settings } from "@homebase/db";
import { requireUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { SettingsFrame } from "@/components/settings/SettingsFrame";
import { ImportsPanel } from "@/components/settings/ImportsPanel";

export const metadata = { title: "Imports" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const cu = await requireUser();
  const db = getDb();
  const accounts = await listAccounts(db);
  // Worker-owned keys (apps/worker/src/settings.ts).
  const rows = await db.select({ key: settings.key, value: settings.value }).from(settings).where(inArray(settings.key, ["ynab_import", "ynab_cutover_date"]));
  const imp = rows.find((r) => r.key === "ynab_import")?.value as { plan_name?: string; imported_at?: string; last_delta_at?: string } | undefined;
  const cutover = rows.find((r) => r.key === "ynab_cutover_date")?.value as string | undefined;
  return (
    <SettingsFrame title="Imports" intro="Bring in history the connections don't cover: bank CSV or OFX files, River and Fidelity exports, and the YNAB migration.">
      <ImportsPanel
        isAdmin={cu.user.role === "admin"}
        accounts={accounts.map((a) => ({ id: a.id, label: a.displayName, kind: a.kind }))}
        ynab={{ imported: imp?.imported_at ? { planName: imp.plan_name ?? "YNAB plan", importedAt: imp.imported_at, lastDeltaAt: imp.last_delta_at ?? null } : null, cutover: typeof cutover === "string" ? cutover : null }}
      />
    </SettingsFrame>
  );
}
