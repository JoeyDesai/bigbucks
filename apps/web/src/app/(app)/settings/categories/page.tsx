import Link from "next/link";
import { listCategories } from "@homebase/core";
import { requireUser } from "@/server/auth";
import { getDb } from "@/server/db";
import { SettingsFrame } from "@/components/settings/SettingsFrame";
import { CategoriesEditor } from "@/components/settings/CategoriesEditor";

export const metadata = { title: "Edit buckets" };
export const dynamic = "force-dynamic";

export default async function Page() {
  await requireUser();
  // System groups (card payments, Ready to Assign) aren't buckets; keep them out of this editor.
  const groups = (await listCategories(getDb(), { includeHidden: true })).filter((g) => !g.isSystem);
  return (
    <SettingsFrame
      title="Edit buckets"
      intro={
        <>
          Add, rename, reorder or hide buckets and groups. To remove a bucket, <strong>merge</strong> it into another one: its past transactions move over. You can also edit one bucket at a time from the{" "}
          <Link href="/budget" className="text-accent underline-offset-2 hover:underline">
            Budget page
          </Link>
          : tap it, then <strong>Edit</strong>. The piggy bank makes a bucket a <strong>savings bucket</strong>.{" "}
          <Link href="/guide#edit" className="text-accent underline-offset-2 hover:underline">
            How buckets work
          </Link>
        </>
      }
    >
      <CategoriesEditor
        groups={groups.map((g) => ({
          id: g.id,
          name: g.name,
          hidden: g.hidden,
          isSystem: g.isSystem,
          categories: g.categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind, hidden: c.hidden, icon: c.icon ?? null, rollover: c.rollover, bucketKind: c.bucketKind })),
        }))}
      />
    </SettingsFrame>
  );
}
