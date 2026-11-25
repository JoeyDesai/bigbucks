import { notFound } from "next/navigation";
import { KitView } from "./KitView";

export const metadata = { title: "UI kit" };

/** Component kit review page. Development only. */
export default function KitPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <KitView />;
}
