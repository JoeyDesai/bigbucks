import { BRAND } from "@/lib/brand";
import { listUsers } from "@homebase/core";
import { requireAdmin } from "@/server/auth";
import { getDb } from "@/server/db";
import { resolveDbUser } from "@/server/settings/dbUser";
import { SettingsFrame } from "@/components/settings/SettingsFrame";
import { UsersEditor } from "@/components/settings/UsersEditor";
import { LOCKOUT_MS, MAX_CONSECUTIVE_FAILURES } from "@/server/identity/pin-policy";

export const metadata = { title: "Users & passwords" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const cu = await requireAdmin();
  const db = getDb();
  const [users, me] = [await listUsers(db), await resolveDbUser(db, cu)];
  return (
    <SettingsFrame
      admin
      title="Users & passwords"
      intro={`Sign in with a username and password. ${MAX_CONSECUTIVE_FAILURES} wrong passwords lock that person out for ${LOCKOUT_MS / 60_000} minutes. On the tailnet, ${BRAND.name} still knows you from your Tailscale login and asks for nothing.`}
    >
      <UsersEditor users={users.map((u) => ({ id: u.id, displayName: u.displayName, role: u.role, tailscaleLogin: u.tailscaleLogin, username: u.username ?? null, hasPassword: u.hasPassword, isYou: u.id === me?.id }))} />
    </SettingsFrame>
  );
}
