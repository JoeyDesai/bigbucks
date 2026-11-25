"use client";
import { useCallback, useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cx } from "@/lib/cx";
import { IconButton } from "./Button";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Optional line under the title. */
  description?: ReactNode;
  children: ReactNode;
  /** Sticky footer (actions). */
  footer?: ReactNode;
  /** Desktop panel width in px (default 440). */
  width?: number;
  /** Mobile: take nearly the full height even with little content. */
  tall?: boolean;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const CLOSE_MS = 260;

/**
 * Bottom sheet on phones, right-side panel on desktop (≥1024px).
 * Modal dialog: focus trap, Escape closes, focus returns to the opener, background scroll locked.
 * Swipe down on the grabber/header to dismiss (pointer events, mobile only).
 */
export function Sheet({ open, onClose, title, description, children, footer, width = 440, tall }: SheetProps) {
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<"open" | "closed">("closed");
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const drag = useRef<{ startY: number; dy: number; t: number; active: boolean } | null>(null);
  const titleId = useId();
  const descId = useId();

  // Mount → next frame animate in; close → animate out → unmount.
  if (open && !mounted) setMounted(true);
  if (!open && state === "open") setState("closed");
  useEffect(() => {
    if (open) {
      restoreRef.current = document.activeElement as HTMLElement | null;
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setState("open")));
      return () => cancelAnimationFrame(r);
    }
    const t = setTimeout(() => setMounted(false), CLOSE_MS);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
      restoreRef.current?.focus?.();
    };
  }, [mounted]);

  useEffect(() => {
    if (state !== "open") return;
    const panel = panelRef.current;
    if (!panel) return;
    const first = panel.querySelector<HTMLElement>("[data-autofocus]") ?? panel;
    first.focus({ preventScroll: true });
  }, [state]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const nodes = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (nodes.length === 0) {
        e.preventDefault();
        return;
      }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (window.matchMedia("(min-width: 1024px)").matches) return;
    if ((e.target as HTMLElement).closest("button,a,input")) return;
    drag.current = { startY: e.clientY, dy: 0, t: performance.now(), active: true };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    const panel = panelRef.current;
    if (!d?.active || !panel) return;
    d.dy = Math.max(0, e.clientY - d.startY);
    panel.style.transition = "none";
    panel.style.transform = `translate3d(0, ${d.dy}px, 0)`;
  }
  function onPointerUp() {
    const d = drag.current;
    const panel = panelRef.current;
    drag.current = null;
    if (!d || !panel) return;
    const velocity = d.dy / Math.max(1, performance.now() - d.t);
    panel.style.transition = "";
    panel.style.transform = "";
    if (d.dy > 110 || velocity > 0.6) onClose();
  }

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50" onKeyDown={onKeyDown}>
      <div
        aria-hidden
        onClick={onClose}
        className={cx("absolute inset-0 bg-scrim transition-opacity duration-200", state === "open" ? "opacity-100" : "opacity-0")}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        data-state={state}
        style={{ ["--sheet-w" as string]: `${width}px` }}
        className={cx(
          "hb-sheet absolute flex flex-col bg-paper outline-none",
          "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-[18px] shadow-pop",
          tall && "h-[92dvh]",
          "lg:inset-y-0 lg:left-auto lg:right-0 lg:h-full lg:max-h-none lg:w-[var(--sheet-w)] lg:rounded-none lg:border-l lg:border-rule",
        )}
      >
        <div
          className="shrink-0 touch-none select-none border-b border-rule px-4 pb-3 pt-2 lg:px-6 lg:pt-5"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div aria-hidden className="mx-auto mb-2 h-1 w-9 rounded-full bg-rule-strong lg:hidden" />
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1 pt-1.5">
              <h2 id={titleId} className="display truncate text-[20px] leading-tight text-ink">
                {title}
              </h2>
              {description && (
                <p id={descId} className="mt-0.5 text-[13px] text-ink-3">
                  {description}
                </p>
              )}
            </div>
            <IconButton label="Close" onClick={onClose} className="-mr-2">
              <X size={20} strokeWidth={1.75} />
            </IconButton>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 lg:px-6">{children}</div>
        {footer && (
          <div className="shrink-0 border-t border-rule bg-paper px-4 pt-3 pb-[calc(12px+var(--safe-bottom))] lg:px-6 lg:pb-5">{footer}</div>
        )}
        {!footer && <div aria-hidden className="h-[var(--safe-bottom)] shrink-0 lg:hidden" />}
      </div>
    </div>,
    document.body,
  );
}
