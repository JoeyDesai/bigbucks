import Link from "next/link";
import { cx } from "@/lib/cx";

/** YNAB's Reflect tabs, plus "More" for the rest of our reports and saved reports. */
export const REFLECT_TABS = [
  { slug: "spending-breakdown", label: "Spending Breakdown" },
  { slug: "spending-trends", label: "Spending Trends" },
  { slug: "net-worth", label: "Net Worth" },
  { slug: "income-vs-expense", label: "Income v Expense" },
  { slug: "age-of-money", label: "Age of Money" },
] as const;

export const isMainReflectTab = (slug: string) => REFLECT_TABS.some((t) => t.slug === slug);

export function ReflectTabs({ active }: { active: string }) {
  const more = !isMainReflectTab(active);
  const tab = (href: string, label: string, on: boolean) => (
    <Link
      key={href}
      href={href}
      aria-current={on ? "page" : undefined}
      className={cx(
        "relative -mb-px shrink-0 whitespace-nowrap border-b-[3px] px-1 pb-2.5 pt-2 text-[14.5px] transition-colors",
        on ? "border-accent font-bold text-ink" : "border-transparent font-semibold text-ink-3 hover:text-ink",
      )}
    >
      {label}
    </Link>
  );
  return (
    <nav aria-label="Reflect" className="scrollbar-none flex gap-5 overflow-x-auto border-b border-rule px-4 lg:gap-7 lg:px-6">
      {REFLECT_TABS.map((t) => tab(`/reports/${t.slug}`, t.label, t.slug === active))}
      {tab("/reports/more", "More", more)}
    </nav>
  );
}
