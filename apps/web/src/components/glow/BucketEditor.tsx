"use client";
import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { EyeOff, GitMerge } from "lucide-react";
import type { BucketRow } from "@homebase/core";
import { cx } from "@/lib/cx";
import { bucketEditOptionsAction, mergeBucketAction, moveBucketAction, renameBucketAction, setSavingsBucketAction, type BucketEditOptions } from "@/server/actions/glow";
import { setCategoryHiddenAction, setCategoryIconAction, undoAction } from "@/server/actions/budget";
import { CategoryIcon } from "@/components/icons/CategoryIcon";
import { IconPicker } from "@/components/icons/IconPicker";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { useToast } from "@/components/ui/Toast";

const FIELD = "h-10 w-full rounded-[10px] border border-rule-strong bg-paper px-3 text-[14px] text-ink outline-none transition-colors focus-visible:border-accent";
const LABEL = "text-[13px] font-medium text-ink-2";

type Res = { ok: true; operationId?: string | null } | { ok: false; error: string };

/**
 * "Edit bucket" at the bottom of a bucket's sheet: name, icon, group, spending or savings, hide, and
 * merge into another bucket. The same edits as Settings → Buckets, without leaving the Budget page.
 */
export function BucketEditor({ r, onClose }: { r: BucketRow; onClose: () => void }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [name, setName] = useState(r.name);
  const [seenName, setSeenName] = useState(r.name);
  if (r.name !== seenName) {
    setSeenName(r.name);
    setName(r.name);
  }
  const [picking, setPicking] = useState(false);
  const [opts, setOpts] = useState<BucketEditOptions | null>(null);
  const [mergeTo, setMergeTo] = useState("");
  const [confirmMerge, setConfirmMerge] = useState(false);
  useEffect(() => {
    let live = true;
    void bucketEditOptionsAction().then((o) => live && setOpts(o));
    return () => {
      live = false;
    };
  }, []);

  function go(p: Promise<Res>, message: string, after?: () => void) {
    start(async () => {
      const res = await p;
      if (!res.ok) return void toast.show({ message: res.error, tone: "error" });
      after?.();
      const op = "operationId" in res ? res.operationId : null;
      toast.show({ message, action: op ? { label: "Undo", onAction: () => void undoAction(op) } : undefined });
    });
  }

  const saveName = () => {
    const n = name.trim();
    if (!n || n === r.name) return setName(r.name);
    go(renameBucketAction({ categoryId: r.id, name: n }), `Renamed to ${n}`);
  };
  const savings = r.bucketKind === "savings";
  const target = opts?.buckets.find((b) => b.id === mergeTo);

  return (
    <section id="bucket-edit" aria-labelledby="bucket-edit-h" className={cx("scroll-mt-4 rounded-[16px] border border-rule p-4", pending && "opacity-80")} data-testid="bucket-editor">
      <h3 id="bucket-edit-h" className="mb-4 text-[14px] font-semibold text-ink">
        Edit bucket
      </h3>
      <div className="space-y-4">
        <label className="block space-y-1.5">
          <span className={LABEL}>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.stopPropagation();
                setName(r.name);
                requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
              }
            }}
            maxLength={100}
            className={FIELD}
            data-testid="bucket-name"
          />
        </label>

        <div className="space-y-1.5">
          <span className={LABEL}>Icon</span>
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-[11px] bg-accent-soft">
              <CategoryIcon icon={r.icon} name={r.name} size={19} tone="accent" />
            </span>
            <button type="button" onClick={() => setPicking((v) => !v)} aria-expanded={picking} className="h-9 rounded-[10px] border border-rule-strong px-3 text-[13px] font-medium text-ink-2 hover:border-accent/60 hover:text-ink">
              {picking ? "Done" : "Change icon"}
            </button>
          </div>
          {picking && (
            <div className="mt-2 rounded-[12px] border border-rule bg-paper p-3">
              <IconPicker
                value={r.icon}
                name={r.name}
                className="max-h-[300px]"
                onPick={(icon) => {
                  setPicking(false);
                  go(setCategoryIconAction({ categoryId: r.id, icon }), icon ? "Icon changed" : "Icon set from the name");
                }}
              />
            </div>
          )}
        </div>

        <label className="block space-y-1.5">
          <span className={LABEL}>Group</span>
          <select value={r.groupId} disabled={!opts} onChange={(e) => go(moveBucketAction({ categoryId: r.id, groupId: e.target.value }), `Moved to ${opts?.groups.find((g) => g.id === e.target.value)?.name ?? "the group"}`)} className={FIELD} data-testid="bucket-group">
            {(opts?.groups ?? [{ id: r.groupId, name: "…" }]).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>

        <div className="space-y-1.5">
          <span className={LABEL}>Kind of bucket</span>
          <SegmentedControl
            label="Kind of bucket"
            size="sm"
            block
            value={savings ? "savings" : "spending"}
            onChange={(v) => {
              const on = v === "savings";
              if (on === savings) return;
              go(setSavingsBucketAction({ categoryId: r.id, enabled: on }), on ? `${r.name} is a savings bucket` : `${r.name} is a spending bucket`);
            }}
            options={[
              { value: "spending", label: "Spending" },
              { value: "savings", label: "Savings" },
            ]}
          />
          <p className="text-[12.5px] leading-snug text-ink-3">
            {savings ? "No monthly goal. You add money as it comes in and the balance carries over month to month." : "Gets a monthly goal and refills every month. Turn on Overflow to keep leftovers."}
          </p>
        </div>

        <div className="space-y-2 border-t border-rule pt-4">
          <span className={LABEL}>Merge into another bucket</span>
          <p className="text-[12.5px] leading-snug text-ink-3">Every past transaction in {r.name} moves to the bucket you pick, and {r.name} is removed. This can&rsquo;t be undone.</p>
          <div className="flex gap-2">
            <select
              value={mergeTo}
              onChange={(e) => {
                setMergeTo(e.target.value);
                setConfirmMerge(false);
              }}
              disabled={!opts}
              className={FIELD}
              data-testid="bucket-merge-target"
            >
              <option value="">Choose a bucket</option>
              {opts?.buckets
                .filter((b) => b.id !== r.id)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
            </select>
            <button
              type="button"
              disabled={!mergeTo || pending}
              onClick={() => {
                if (!confirmMerge) return setConfirmMerge(true);
                go(mergeBucketAction({ sourceId: r.id, targetId: mergeTo }), `Merged ${r.name} into ${target?.label.split(" · ").pop() ?? "the bucket"}`, onClose);
              }}
              className={cx("inline-flex h-10 shrink-0 items-center gap-1.5 rounded-[10px] px-3 text-[13px] font-semibold transition-colors disabled:opacity-40", confirmMerge ? "bg-over text-white" : "border border-rule-strong text-ink-2 hover:text-ink")}
              data-testid="bucket-merge"
            >
              <GitMerge size={15} aria-hidden /> {confirmMerge ? "Yes, merge" : "Merge"}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-4">
          <button
            type="button"
            disabled={pending}
            onClick={() => go(setCategoryHiddenAction({ categoryId: r.id, hidden: true }), `${r.name} is hidden`, onClose)}
            className="inline-flex h-9 items-center gap-1.5 rounded-[10px] px-2 text-[13px] font-medium text-ink-3 hover:bg-paper-hover hover:text-ink"
            data-testid="bucket-hide"
          >
            <EyeOff size={15} aria-hidden /> Hide this bucket
          </button>
          <Link href="/settings/categories" className="text-[13px] font-medium text-accent hover:underline">
            Add buckets or reorder them
          </Link>
        </div>
      </div>
    </section>
  );
}
