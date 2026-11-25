"use client";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";

export const SHORTCUTS: { group: string; items: { keys: string[]; label: string }[] }[] = [
  {
    group: "Move",
    items: [
      { keys: ["↑", "↓"], label: "Previous / next transaction" },
      { keys: ["j", "k"], label: "Next / previous (vim style)" },
      { keys: ["⇧", "↑↓"], label: "Extend the selection" },
      { keys: ["x"], label: "Select or unselect" },
      { keys: ["Esc"], label: "Clear selection, close" },
      { keys: ["/"], label: "Search" },
    ],
  },
  {
    group: "Categorize",
    items: [
      { keys: ["Enter"], label: "Accept the suggestion and approve" },
      { keys: ["⇧", "Enter"], label: "Accept for every one from this payee" },
      { keys: ["1", "2", "3"], label: "Pick suggestion 1, 2 or 3" },
      { keys: ["a…z"], label: "Type a category name (gro ↵)" },
      { keys: ["u"], label: "Undo the last change" },
    ],
  },
  {
    group: "Edit",
    items: [
      { keys: ["e"], label: "Edit the transaction" },
      { keys: ["s"], label: "Split it" },
      { keys: ["t"], label: "Mark it as a transfer" },
    ],
  },
  {
    group: "Budget",
    items: [
      { keys: ["←", "→"], label: "Previous / next month" },
      { keys: ["?"], label: "This cheat sheet" },
    ],
  },
];

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/** "?" anywhere (or the avatar menu's "Keyboard shortcuts") opens the cheat sheet. */
export function ShortcutSheet() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]:not([data-shortcuts])')) return;
      if (e.key === "?") {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
        return;
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("hb:shortcuts", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("hb:shortcuts", onOpen);
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[65] flex items-end justify-center p-3 sm:items-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
          <div aria-hidden className="absolute inset-0 bg-scrim backdrop-blur-[2px]" onClick={() => setOpen(false)} />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            data-shortcuts
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            className="glass relative w-full max-w-[720px] rounded-[24px] p-6 shadow-pop"
            style={{ background: "var(--glass-strong)" }}
          >
            <div className="mb-5 flex items-center justify-between">
              <div>
                <h2 className="display text-[20px] text-ink">Keyboard shortcuts</h2>
                <p className="text-[13px] text-ink-3">Categorize a week of spending in a few seconds.</p>
              </div>
              <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-3 hover:bg-paper-hover hover:text-ink">
                <X size={18} strokeWidth={1.8} />
              </button>
            </div>
            <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
              {SHORTCUTS.map((s) => (
                <section key={s.group} aria-label={s.group}>
                  <h3 className="eyebrow mb-2">{s.group}</h3>
                  <ul className="space-y-1.5">
                    {s.items.map((it) => (
                      <li key={it.label} className="flex items-center justify-between gap-3 text-[13.5px] text-ink-2">
                        <span>{it.label}</span>
                        <span className="flex shrink-0 gap-1">
                          {it.keys.map((k) => (
                            <kbd key={k} className="kbd">
                              {k}
                            </kbd>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
