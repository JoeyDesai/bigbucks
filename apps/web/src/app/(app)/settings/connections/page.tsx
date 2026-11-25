import { requireAdmin } from "@/server/auth";
import { getDb } from "@/server/db";
import { resolveAnthropicKey } from "@/server/ai/client";
import { listConnections } from "@/server/settings/connections";
import { SettingsFrame } from "@/components/settings/SettingsFrame";
import { ConnectionsEditor } from "@/components/settings/ConnectionsEditor";

export const metadata = { title: "Connections" };
export const dynamic = "force-dynamic";

export default async function Page() {
  await requireAdmin();
  const db = getDb();
  const [conns, key] = [await listConnections(db), await resolveAnthropicKey(db)];
  return (
    <SettingsFrame admin title="Connections" intro="Every connection is read-only. Keys are stored encrypted with the server's master key, and only the last 4 characters are ever shown. SimpleFIN allows 6 requests a day, 2 of them manual.">
      <ConnectionsEditor connections={conns} anthropic={{ configured: !!key.key, source: key.source }} />
    </SettingsFrame>
  );
}
