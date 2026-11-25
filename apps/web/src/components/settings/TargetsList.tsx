"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { formatMilli } from "@homebase/shared";
import type { CategoryVM, GroupVM } from "@/lib/view-models";
import { TargetEditor } from "@/components/budget/TargetEditor";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { cx } from "@/lib/cx";

/** Every target in one list (§12.6 "Targets"), edited with the Plan sheet's TargetEditor (core editTarget). */
export function TargetsList({ month, monthLabel, groups }: { month: string; monthLabel: string; groups: GroupVM[] }) {
  const toast = useToast();
  const router = useRouter();
  const [filter, setFilter] = useState<"with" | "all">("with");
  const [open, setOpen] = useState<CategoryVM | null>(null);
  const shown = useMemo(
    () => groups.map((g) => ({ ...g, categories: g.categories.filter((c) => (filter === "all" ? c.kind === "normal" || c.kind === "cc_payment" : !!c.target)) })).filter((g) => g.categories.length > 0),
    [groups, filter],
  );
  const total = groups.reduce((n, g) => n + g.categories.filter((c) => c.target).length, 0);
  return (
    <div>
      <SegmentedControl
        label="Show"
        variant="underline"
        value={filter}
        onChange={setFilter}
        options={[
          { value: "with", label: "With a target", count: total },
          { value: "all", label: "All categories" },
        ]}
        className="mb-6"
      />
      {shown.length === 0 && <p className="py-6 text-[14px] text-ink-3">No targets yet. Pick All categories to add one.</p>}
      <div className="space-y-8">
        {shown.map((g) => (
          <section key={g.id} aria-label={g.name}>
            <h2 className="eyebrow mb-1">{g.name}</h2>
            <ul className="border-t border-rule">
              {g.categories.map((c) => (
                <li key={c.id} className="border-b border-rule">
                  <button type="button" onClick={() => setOpen(c)} className="group flex min-h-[60px] w-full items-center gap-3 py-2.5 text-left">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] text-ink">{c.name}</span>
                      <span className={cx("block truncate text-[12px]", c.target ? "text-ink-2" : "text-ink-3")}>
                        {c.target ? c.target.description : "No target"}
                        {c.target?.snoozed ? " · snoozed this month" : ""}
                      </span>
                    </span>
                    {c.target && (
                      <span className="num shrink-0 text-right text-[13px]">
                        {c.target.underfunded > 0n ? <span className="text-warn">{formatMilli(c.target.underfunded)} to go</span> : <span className="text-pos">Funded</span>}
                      </span>
                    )}
                    <ChevronRight size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <Sheet open={!!open} onClose={() => setOpen(null)} title={open ? open.name : "Target"} description={`Changes apply from ${monthLabel} on; earlier months keep the target they had.`}>
        {open && (
          <TargetEditor
            month={month}
            category={open}
            onDone={(message) => {
              setOpen(null);
              toast.show({ message });
              router.refresh();
            }}
            onError={(message) => toast.show({ message, tone: "error" })}
            onCancel={() => setOpen(null)}
          />
        )}
      </Sheet>
    </div>
  );
}
