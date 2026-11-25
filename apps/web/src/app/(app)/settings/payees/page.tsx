import { listCategories, listPayees } from "@homebase/core";
import { requireUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { SettingsFrame } from "@/components/settings/SettingsFrame";
import { PayeesEditor } from "@/components/settings/PayeesEditor";

export const metadata = { title: "Payees" };
export const dynamic = "force-dynamic";

export default async function Page() {
  await requireUser();
  const db = getDb();
  const [payees, groups] = [await listPayees(db, { limit: 5000 }), await listCategories(db)];
  const categories = groups.filter((g) => !g.isSystem).flatMap((g) => g.categories.filter((c) => c.kind === "normal").map((c) => ({ id: c.id, label: `${g.name} · ${c.name}` })));
  return (
    <SettingsFrame title="Payees" intro="Rename and merge payees, set a default category, manage the bank descriptions that map to each one, and see what a merchant is.">
      <PayeesEditor
        categories={categories}
        payees={payees.map((p) => ({
          id: p.id,
          name: p.name,
          defaultCategoryName: p.defaultCategoryName,
          transactionCount: p.transactionCount,
          lastUsed: p.lastUsed,
          aliasCount: p.aliasCount,
          hasMerchant: !!p.merchant,
        }))}
      />
    </SettingsFrame>
  );
}
