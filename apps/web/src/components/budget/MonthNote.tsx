"use client";
import { useState } from "react";

/** Month note under the month name ("Enter a note..."): tap to edit, Enter/blur saves, Escape cancels. */
export function MonthNote({ note, onSave, className }: { note: string; onSave: (note: string) => Promise<void>; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note);
  const [shown, setShown] = useState(note);
  const [seen, setSeen] = useState(note);
  if (note !== seen) {
    setSeen(note);
    setShown(note);
  }
  const commit = async () => {
    setEditing(false);
    if (text.trim() === shown.trim()) return;
    setShown(text);
    await onSave(text.trim());
  };
  if (editing)
    return (
      <div className={className}>
        <label htmlFor="month-note" className="sr-only">
          Month note
        </label>
        <input
          id="month-note"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            } else if (e.key === "Escape") {
              setText(shown);
              setEditing(false);
            }
          }}
          placeholder="Enter a note..."
          className="h-8 w-full max-w-[320px] rounded-md border-2 border-accent bg-paper-raised px-2 text-[13px] outline-none"
        />
      </div>
    );
  return (
    <button
      type="button"
      onClick={() => {
        setText(shown);
        setEditing(true);
      }}
      aria-label={shown ? `Month note: ${shown}. Edit` : "Add a note for this month"}
      className={`block max-w-[320px] truncate rounded-md text-left text-[13px] ${shown ? "text-ink-2" : "text-ink-3 hover:text-accent"} ${className ?? ""}`}
    >
      {shown || "Enter a note..."}
    </button>
  );
}
