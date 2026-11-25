import { BRAND } from "@/lib/brand";
import { requireUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { log } from "@/server/log";
import { requireDbUser } from "@/server/settings/dbUser";
import { ALERT_TYPES, getOrCreateVapidPublic, getPushPreferences, listSubscriptions } from "@/server/settings/push";
import { SettingsFrame } from "@/components/settings/SettingsFrame";
import { NotificationsEditor } from "@/components/settings/NotificationsEditor";

export const metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const cu = await requireUser();
  const db = getDb();
  const user = await requireDbUser(db, cu);
  const [prefs, subs] = [await getPushPreferences(db, user.id), await listSubscriptions(db, user.id)];
  let subject: string | null = null;
  try {
    subject = (await getOrCreateVapidPublic(db)).subject;
  } catch (e) {
    log.warn({ err: (e as Error).message }, "vapid keys unavailable");
  }
  return (
    <SettingsFrame title="Notifications" intro={`Push alerts from ${BRAND.name}: overspending, large transactions, card due dates and the weekly digest. Admins also get connection, backup and AI-cost alerts.`}>
      <NotificationsEditor
        isAdmin={cu.user.role === "admin"}
        deviceCount={subs.length}
        vapidSubject={subject}
        prefs={ALERT_TYPES.map((a) => ({ type: a.type, label: a.label, admin: a.admin, enabled: prefs[a.type] }))}
      />
    </SettingsFrame>
  );
}
