import { monthOf, today } from "@homebase/shared";
import { requireUser } from "@/server/auth";
import { loadPlan } from "@/server/queries/plan";
import { SettingsFrame } from "@/components/settings/SettingsFrame";
import { TargetsList } from "@/components/settings/TargetsList";

export const metadata = { title: "Targets" };
export const dynamic = "force-dynamic";

export default async function Page() {
  await requireUser();
  const t = today();
  const month = monthOf(t);
  const plan = await loadPlan(month, t);
  return (
    <SettingsFrame title="Targets" intro={`Every category target in one place, with this month's progress (${plan.label}). Edits apply from this month on.`}>
      <TargetsList month={month} monthLabel={plan.label} groups={plan.groups} />
    </SettingsFrame>
  );
}
