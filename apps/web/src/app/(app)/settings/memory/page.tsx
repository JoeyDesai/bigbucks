import { listMemory } from "@homebase/core";
import { requireUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { SettingsFrame } from "@/components/settings/SettingsFrame";
import { MemoryEditor } from "@/components/settings/MemoryEditor";

export const metadata = { title: "Household memory" };
export const dynamic = "force-dynamic";

export default async function Page() {
  await requireUser();
  const items = await listMemory(getDb());
  return (
    <SettingsFrame title="Household memory" intro="Plain facts Ask can use when it answers, like “Paychecks land on the 25th” or “Costco runs are mostly groceries”. Both of you can edit them.">
      <MemoryEditor items={items.map((m) => ({ id: m.id, text: m.text, by: m.createdByName, at: m.createdAt.toISOString() }))} />
    </SettingsFrame>
  );
}
