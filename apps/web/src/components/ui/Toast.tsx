"use client";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

export interface ToastOptions {
  message: ReactNode;
  /** e.g. { label: "Undo", onAction } — every budget action offers Undo (spec §12). */
  action?: { label: string; onAction: () => void };
  /** A second action (e.g. "Apply to 3 more"). */
  secondary?: { label: string; onAction: () => void };
  /** ms; default 5000 (7000 with an action). */
  duration?: number;
  tone?: "default" | "error";
}

interface ToastItem extends ToastOptions {
  id: number;
}

interface ToastApi {
  show: (opts: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

/** Toast stack: sits above the tab bar on phones, bottom-left of content on desktop. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
  }, []);

  const show = useCallback(
    (opts: ToastOptions) => {
      const id = nextId.current++;
      setItems((xs) => [...xs.slice(-2), { ...opts, id }]);
      const ms = opts.duration ?? (opts.action ? 7000 : 5000);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), ms),
      );
      return id;
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-2 px-4 bottom-[calc(var(--tabbar-h)+var(--safe-bottom)+12px)] lg:bottom-6 lg:left-[var(--sidebar-w)] lg:items-center lg:px-8"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className="pointer-events-auto flex w-full max-w-[460px] items-center gap-3 rounded-[16px] border border-white/10 bg-nav/95 py-1.5 pl-4 pr-1.5 text-[14px] text-white shadow-pop backdrop-blur-xl"
            style={{ animation: "hb-toast-in 260ms var(--ease-out-expo)" }}
          >
            {t.tone === "error" && <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-neg-bar" />}
            <div className="min-w-0 flex-1 py-1.5">{t.message}</div>
            {t.secondary && (
              <button
                type="button"
                onClick={() => {
                  t.secondary!.onAction();
                  dismiss(t.id);
                }}
                className="min-h-9 shrink-0 rounded-[10px] px-2.5 text-[13px] font-semibold text-white/85 hover:bg-white/12"
              >
                {t.secondary.label}
              </button>
            )}
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action!.onAction();
                  dismiss(t.id);
                }}
                className="min-h-9 shrink-0 rounded-[10px] bg-white/12 px-3 text-[13px] font-semibold hover:bg-white/22"
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
              className="flex h-10 w-10 shrink-0 items-center justify-center opacity-60 hover:opacity-100"
            >
              <X size={16} strokeWidth={1.75} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
