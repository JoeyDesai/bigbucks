"use client";
import { BRAND } from "@/lib/brand";
import { useEffect, useState } from "react";
import { X } from "lucide-react";

const KEY = "hb_install_hint_dismissed";

function shouldShow(): boolean {
  const ua = navigator.userAgent;
  const iOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true || window.matchMedia("(display-mode: standalone)").matches;
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(KEY) === "1";
  } catch {
    dismissed = false;
  }
  return iOS && safari && !standalone && !dismissed;
}

/** iOS Safari share-sheet glyph (square with up arrow). */
function ShareGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="mx-0.5 inline -translate-y-px">
      <path d="M12 3v12" />
      <path d="M8 7l4-4 4 4" />
      <path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
    </svg>
  );
}

/** "Add to Home Screen" hint for iOS Safari when not installed (in-flow at the top of the page). Dismissal is remembered. */
export function InstallHint() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    // Client-only detection; runs once after hydration.
    const t = setTimeout(() => setShow(shouldShow()), 1200);
    return () => clearTimeout(t);
  }, []);
  if (!show) return null;
  const dismiss = () => {
    setShow(false);
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* private mode: just hide for this visit */
    }
  };
  return (
    <div
      role="region"
      aria-label={`Install ${BRAND.name}`}
      className="mx-4 mt-3 flex items-start gap-3 border border-rule-strong bg-paper-raised py-3 pl-4 pr-1 text-[13px] text-ink-2 lg:hidden"
      style={{ animation: "hb-pop 240ms var(--ease-out-quart)" }}
    >
      <span aria-hidden className="mt-1 h-2 w-2 shrink-0 bg-accent" />
      <p className="flex-1 leading-snug">
        <span className="font-semibold text-ink">Install {BRAND.name}.</span> Tap <ShareGlyph /> Share, then <span className="text-ink">Add to Home Screen</span> for a full-screen app with notifications.
      </p>
      <button type="button" onClick={dismiss} aria-label="Dismiss install hint" className="-mt-2 flex h-11 w-11 shrink-0 items-center justify-center text-ink-3 hover:text-ink">
        <X size={16} strokeWidth={1.75} />
      </button>
    </div>
  );
}
