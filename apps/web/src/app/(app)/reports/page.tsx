import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";

/** Reflect opens on Spending Breakdown, like YNAB. */
export default async function ReflectIndex() {
  await requireUser();
  redirect("/reports/spending-breakdown");
}
