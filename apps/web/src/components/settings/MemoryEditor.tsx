"use client";
import { useState, useTransition } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { addMemoryAction, deleteMemoryAction, updateMemoryAction } from "@/server/settings/actions/household";
import { Button, IconButton } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { INPUT } from "./fields";

export interface MemoryItem {
  id: string;
  text: string;
  by: string | null;
  at: string;
}

/** Household memory (§5.4): plain facts Ask reads. Add, edit in place, delete. */
export function MemoryEditor({ items }: { items: MemoryItem[] }) {
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [pending, start] = useTransition();

  const run = (p: Promise<{ ok: true } | { ok: false; error: string }>, done?: () => void, msg?: string) =>
    start(async () => {
      const r = await p;
      if (r.ok) {
        done?.();
        if (msg) toast.show({ message: msg });
      } else toast.show({ message: r.error, tone: "error" });
    });

  return (
    <div>
      <form
        className="mb-8 flex items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) run(addMemoryAction(draft), () => setDraft(""), "Added to household memory");
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="sr-only">New fact</span>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={500} placeholder="e.g. Paychecks land on the 25th" className={INPUT} />
        </label>
        <Button type="submit" variant="primary" disabled={!draft.trim()} busy={pending && !editing}>
          Add
        </Button>
      </form>
      {items.length === 0 ? (
        <p className="border-t border-rule py-6 text-[14px] text-ink-3">No facts yet. Ask also offers to remember things you tell it, after you confirm.</p>
      ) : (
        <ul className="border-t border-rule">
          {items.map((m) => (
            <li key={m.id} className="border-b border-rule py-3">
              {editing === m.id ? (
                <form
                  className="flex items-start gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(updateMemoryAction(m.id, editText), () => setEditing(null), "Saved");
                  }}
                >
                  <input autoFocus value={editText} onChange={(e) => setEditText(e.target.value)} maxLength={500} className={INPUT} aria-label="Edit fact" />
                  <Button type="submit" variant="primary" size="md" busy={pending}>
                    Save
                  </Button>
                  <Button variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] text-ink">{m.text}</p>
                    <p className="mt-0.5 text-[12px] text-ink-3">
                      {m.by ? `Added by ${m.by}` : "Added by Ask"} · {new Date(m.at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                    </p>
                  </div>
                  <IconButton
                    label="Edit"
                    onClick={() => {
                      setEditing(m.id);
                      setEditText(m.text);
                    }}
                  >
                    <Pencil size={16} strokeWidth={1.6} />
                  </IconButton>
                  <IconButton label="Delete" onClick={() => run(deleteMemoryAction(m.id), undefined, "Deleted")}>
                    <Trash2 size={16} strokeWidth={1.6} />
                  </IconButton>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
