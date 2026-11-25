"use client";
import { BRAND } from "@/lib/brand";
import { Redo2, Undo2 } from "lucide-react";
import { cx } from "@/lib/cx";
import { timeAgo } from "@/lib/format";
import type { RecentMoveVM } from "@/server/queries/plan";

/** "Recent Moves" (§6.6): this month's budget operations, newest first, each undoable / redoable. */
export function RecentMoves({ moves, onUndo, onRedo, pending, className }: { moves: RecentMoveVM[]; onUndo: (id: string) => void; onRedo: (id: string) => void; pending?: boolean; className?: string }) {
  if (!moves.length) return <p className={cx("text-[13px] text-ink-3", className)}>No moves this month yet.</p>;
  return (
    <ol className={cx("border-t border-rule", className)}>
      {moves.map((m) => (
        <li key={m.id} className="flex items-start gap-2 border-b border-rule py-2">
          <div className="min-w-0 flex-1">
            <p className={cx("text-[13px] leading-snug", m.undone ? "text-ink-3 line-through decoration-ink-3/50" : "text-ink")}>{m.description}</p>
            <p className="text-[11px] text-ink-3">
              {m.userName ?? BRAND.name} · {timeAgo(m.at)}
              {m.undone && " · undone"}
            </p>
          </div>
          {m.canUndo && !m.undone && (
            <button type="button" disabled={pending} onClick={() => onUndo(m.id)} aria-label={`Undo: ${m.description}`} className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-xs px-2 text-[12px] text-ink-2 hover:bg-paper-sunken hover:text-ink disabled:opacity-40">
              <Undo2 size={13} strokeWidth={1.75} aria-hidden /> Undo
            </button>
          )}
          {m.canRedo && m.undone && (
            <button type="button" disabled={pending} onClick={() => onRedo(m.id)} aria-label={`Redo: ${m.description}`} className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-xs px-2 text-[12px] text-ink-2 hover:bg-paper-sunken hover:text-ink disabled:opacity-40">
              <Redo2 size={13} strokeWidth={1.75} aria-hidden /> Redo
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
