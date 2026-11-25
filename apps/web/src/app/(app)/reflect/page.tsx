import { monthOf, today as localToday } from "@homebase/shared";
import { parseMonthParam } from "@/lib/format";
import { requireUser } from "@/server/auth";
import { loadReflect } from "@/server/queries/glow";
import { ReflectView } from "./ReflectView";

export const metadata = { title: "Reflect" };

/** Reflect: spending by bucket, every month side by side, and one bucket over time. `?m=YYYY-MM` picks the month, `?b=<id>` the bucket. */
export default async function ReflectPage({ searchParams }: { searchParams: Promise<{ m?: string; b?: string }> }) {
  await requireUser();
  const { m, b } = await searchParams;
  const today = localToday();
  const current = monthOf(today);
  const month = parseMonthParam(m) ?? current;
  const data = await loadReflect(month > current ? current : month, today);
  return <ReflectView key={month} data={data} currentMonth={current} initialBucket={b ?? null} />;
}
