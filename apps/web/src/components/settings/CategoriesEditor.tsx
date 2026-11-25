"use client";
import { CategoryIcon } from "@/components/icons/CategoryIcon";
import { useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, GitMerge, IterationCw, Pencil, PiggyBank, Plus } from "lucide-react";
import { cx } from "@/lib/cx";
import {
  createCategoryAction,
  createGroupAction,
  mergeCategoriesAction,
  renameCategoryAction,
  renameGroupAction,
  reorderCategoriesAction,
  reorderGroupsAction,
  setCategoryHiddenAction,
  setGroupHiddenAction,
} from "@/server/settings/actions/household";
import { setSavingsBucketAction } from "@/server/actions/glow";
import { undoAction } from "@/server/actions/budget";
import { Button, IconButton } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { INPUT, SelectField } from "./fields";

export interface CatItem {
  id: string;
  name: string;
  kind: string;
  hidden: boolean;
  icon?: string | null;
  /** Overflow (rollover) is on: leftovers roll into next month. */
  rollover?: boolean;
  /** 'savings': money is added as it comes in and the balance carries over (no monthly goal). */
  bucketKind?: "spending" | "savings";
}
export interface GroupItem {
  id: string;
  name: string;
  hidden: boolean;
  isSystem: boolean;
  categories: CatItem[];
}

type Result = { ok: true } | { ok: false; error: string };

function InlineName({ value, onSave, label, disabled }: { value: string; onSave: (v: string) => void; label: string; disabled?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  if (!editing)
    return (
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate">{value}</span>
        {!disabled && (
          <IconButton
            label={`Rename ${label}`}
            className="h-9 w-9"
            onClick={() => {
              setV(value);
              setEditing(true);
            }}
          >
            <Pencil size={14} strokeWidth={1.6} />
          </IconButton>
        )}
      </span>
    );
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setEditing(false);
        if (v.trim() && v.trim() !== value) onSave(v.trim());
      }}
    >
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditing(false)} aria-label={`New name for ${label}`} className={cx(INPUT, "h-9")} maxLength={100} />
      <Button type="submit" size="sm" variant="primary">
        Save
      </Button>
    </form>
  );
}

/** Categories & groups (§12.6): create, rename, reorder, hide, and merge with confirmation. */
export function CategoriesEditor({ groups }: { groups: GroupItem[] }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [newGroup, setNewGroup] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const [newCat, setNewCat] = useState("");
  const [merge, setMerge] = useState<CatItem | null>(null);
  const [mergeTarget, setMergeTarget] = useState("");

  const run = (p: Promise<Result>, ok?: string, after?: () => void) =>
    start(async () => {
      const r = await p;
      if (r.ok) {
        after?.();
        if (ok) toast.show({ message: ok });
      } else toast.show({ message: r.error, tone: "error" });
    });

  const toggleSavings = (c: CatItem) => {
    const on = c.bucketKind !== "savings";
    start(async () => {
      const r = await setSavingsBucketAction({ categoryId: c.id, enabled: on });
      if (!r.ok) return void toast.show({ message: r.error, tone: "error" });
      toast.show({
        message: on ? `${c.name} is a savings bucket` : `${c.name} is a spending bucket again`,
        action: r.operationId ? { label: "Undo", onAction: () => void undoAction(r.operationId!) } : undefined,
      });
    });
  };

  const userGroups = groups.filter((g) => !g.isSystem);
  const mergeable = groups.flatMap((g) => g.categories.filter((c) => c.kind === "normal").map((c) => ({ ...c, group: g.name })));

  const moveGroup = (i: number, d: -1 | 1) => {
    const ids = userGroups.map((g) => g.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    // System groups keep their slots at the front.
    run(reorderGroupsAction([...groups.filter((g) => g.isSystem).map((g) => g.id), ...ids]));
  };
  const moveCat = (g: GroupItem, i: number, d: -1 | 1) => {
    const ids = g.categories.map((c) => c.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    run(reorderCategoriesAction(g.id, ids));
  };

  return (
    <div className={cx(pending && "opacity-80 transition-opacity")}>
      <form
        className="mb-10 flex items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (newGroup.trim()) run(createGroupAction(newGroup), `Created ${newGroup.trim()}`, () => setNewGroup(""));
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="sr-only">New group name</span>
          <input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="New group name" className={INPUT} maxLength={100} />
        </label>
        <Button type="submit" icon={<Plus size={15} strokeWidth={1.75} />} disabled={!newGroup.trim()}>
          Add group
        </Button>
      </form>

      <div className="space-y-10">
        {groups.map((g) => {
          const gi = userGroups.findIndex((x) => x.id === g.id);
          return (
            <section key={g.id} aria-label={g.name}>
              <div className="flex min-h-11 items-center gap-1 border-b border-rule-strong pb-1">
                <div className={cx("display min-w-0 flex-1 text-[19px]", g.hidden && "text-ink-3")}>
                  <InlineName value={g.name} label={g.name} disabled={g.isSystem} onSave={(v) => run(renameGroupAction(g.id, v), "Renamed")} />
                </div>
                {g.isSystem ? (
                  <span className="eyebrow">System</span>
                ) : (
                  <>
                    <IconButton label={`Move ${g.name} up`} disabled={gi <= 0} onClick={() => moveGroup(gi, -1)}>
                      <ArrowUp size={15} strokeWidth={1.6} />
                    </IconButton>
                    <IconButton label={`Move ${g.name} down`} disabled={gi >= userGroups.length - 1} onClick={() => moveGroup(gi, 1)}>
                      <ArrowDown size={15} strokeWidth={1.6} />
                    </IconButton>
                    <IconButton label={g.hidden ? `Show ${g.name}` : `Hide ${g.name}`} onClick={() => run(setGroupHiddenAction(g.id, !g.hidden), g.hidden ? "Shown" : "Hidden")}>
                      {g.hidden ? <EyeOff size={15} strokeWidth={1.6} /> : <Eye size={15} strokeWidth={1.6} />}
                    </IconButton>
                  </>
                )}
              </div>
              <ul>
                {g.categories.map((c, i) => (
                  <li key={c.id} className="flex min-h-[52px] items-center gap-1 border-b border-rule">
                    <CategoryIcon icon={c.icon} name={c.name} size={17} className="ml-1 mr-1.5" />
                    <div className={cx("min-w-0 flex-1 text-[15px]", c.hidden ? "text-ink-3" : "text-ink")}>
                      <InlineName value={c.name} label={c.name} disabled={c.kind === "internal_rta" || c.kind === "uncategorized"} onSave={(v) => run(renameCategoryAction(c.id, v), "Renamed")} />
                    </div>
                    {c.bucketKind === "savings" && (
                      <span className="mr-2 inline-flex items-center gap-1 text-[12px] text-accent max-sm:hidden" title="Savings bucket: add money as it comes in" data-testid="savings-flag">
                        <PiggyBank size={13} strokeWidth={2} aria-hidden />
                        Savings
                      </span>
                    )}
                    {c.rollover && (
                      <span className="mr-2 inline-flex items-center gap-1 text-[12px] text-accent" title="Leftovers roll into next month" data-testid="rollover-flag">
                        <IterationCw size={13} strokeWidth={2} aria-hidden />
                        <span className="hidden sm:inline">Rolls over</span>
                        <span className="sr-only sm:hidden">Rolls over</span>
                      </span>
                    )}
                    {c.hidden && <span className="mr-2 text-[12px] text-ink-3">Hidden</span>}
                    {!g.isSystem && (
                      <>
                        <IconButton label={`Move ${c.name} up`} disabled={i === 0} onClick={() => moveCat(g, i, -1)} className="max-sm:hidden">
                          <ArrowUp size={15} strokeWidth={1.6} />
                        </IconButton>
                        <IconButton label={`Move ${c.name} down`} disabled={i === g.categories.length - 1} onClick={() => moveCat(g, i, 1)} className="max-sm:hidden">
                          <ArrowDown size={15} strokeWidth={1.6} />
                        </IconButton>
                      </>
                    )}
                    {c.kind === "normal" && (
                      <IconButton
                        label={c.bucketKind === "savings" ? `Make ${c.name} a spending bucket` : `Make ${c.name} a savings bucket`}
                        aria-pressed={c.bucketKind === "savings"}
                        onClick={() => toggleSavings(c)}
                      >
                        <PiggyBank size={15} strokeWidth={c.bucketKind === "savings" ? 2.2 : 1.6} className={c.bucketKind === "savings" ? "text-accent" : undefined} />
                      </IconButton>
                    )}
                    {c.kind !== "internal_rta" && (
                      <IconButton label={c.hidden ? `Show ${c.name}` : `Hide ${c.name}`} onClick={() => run(setCategoryHiddenAction(c.id, !c.hidden), c.hidden ? "Shown" : "Hidden")}>
                        {c.hidden ? <EyeOff size={15} strokeWidth={1.6} /> : <Eye size={15} strokeWidth={1.6} />}
                      </IconButton>
                    )}
                    {c.kind === "normal" && (
                      <IconButton
                        label={`Merge ${c.name} into another category`}
                        onClick={() => {
                          setMerge(c);
                          setMergeTarget("");
                        }}
                      >
                        <GitMerge size={15} strokeWidth={1.6} />
                      </IconButton>
                    )}
                  </li>
                ))}
              </ul>
              {!g.isSystem &&
                (adding === g.id ? (
                  <form
                    className="mt-2 flex items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (newCat.trim())
                        run(createCategoryAction(g.id, newCat), `Added ${newCat.trim()}`, () => {
                          setNewCat("");
                          setAdding(null);
                        });
                    }}
                  >
                    <input autoFocus value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="Category name" aria-label={`New category in ${g.name}`} className={cx(INPUT, "h-10")} maxLength={100} />
                    <Button type="submit" size="sm" variant="primary" disabled={!newCat.trim()}>
                      Add
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setAdding(null)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setAdding(g.id);
                      setNewCat("");
                    }}
                    className="mt-1 inline-flex min-h-11 items-center gap-1.5 text-[13px] text-ink-2 hover:text-ink"
                  >
                    <Plus size={14} strokeWidth={1.75} aria-hidden /> Add category
                  </button>
                ))}
            </section>
          );
        })}
      </div>

      <Sheet
        open={!!merge}
        onClose={() => setMerge(null)}
        title={merge ? `Merge ${merge.name}` : "Merge"}
        description="Every transaction, split, scheduled transaction and assignment moves to the category you pick, and this category is removed. This rewrites history and can't be undone."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setMerge(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!mergeTarget || pending}
              onClick={() => {
                if (!merge || !mergeTarget) return;
                const target = mergeable.find((m) => m.id === mergeTarget);
                run(mergeCategoriesAction(merge.id, mergeTarget), `Merged ${merge.name} into ${target?.name ?? "the category"}`, () => setMerge(null));
              }}
            >
              Merge and recategorize history
            </Button>
          </div>
        }
      >
        <SelectField label="Merge into" value={mergeTarget} onChange={(e) => setMergeTarget(e.target.value)}>
          <option value="">Choose a category</option>
          {mergeable
            .filter((m) => m.id !== merge?.id)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.group} · {m.name}
              </option>
            ))}
        </SelectField>
      </Sheet>
    </div>
  );
}
