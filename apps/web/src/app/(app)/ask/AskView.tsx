"use client";
import { BRAND } from "@/lib/brand";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessagesSquare, Plus, Sparkles } from "lucide-react";
import type { ChartSpec } from "@homebase/ai";
import { cx } from "@/lib/cx";
import { formatDay } from "@/lib/format";
import { AskComposer } from "@/components/ask/AskComposer";
import { AskTurn } from "@/components/ask/AskTurn";
import type { CategoryOption } from "@/components/ask/AskAction";
import type { Recording } from "@/components/ask/MicButton";
import { parseSse, reduceTurn, type ClientEvent } from "@/components/ask/stream";
import { SUGGESTED_PROMPTS, type ActionVM, type AskStatusVM, type AskTurnVM, type ConversationListItem } from "@/components/ask/types";
import { PageHeader } from "@/components/shell/PageHeader";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";

export interface AskViewProps {
  conversations: ConversationListItem[];
  turns: AskTurnVM[];
  conversationId: string | null;
  title?: string;
  status: AskStatusVM;
  categories: CategoryOption[];
}

const PREF_SPEAK = "hb_ask_speak";
const PREF_AUTOSEND = "hb_ask_autosend";
const PREF_EVENT = "hb-pref-change";

/** A per-device boolean in localStorage (speak replies, auto-send voice), SSR-safe. */
function usePref(key: string, fallback: boolean): [boolean, (v: boolean) => void] {
  const value = useSyncExternalStore(
    (cb) => {
      window.addEventListener(PREF_EVENT, cb);
      window.addEventListener("storage", cb);
      return () => {
        window.removeEventListener(PREF_EVENT, cb);
        window.removeEventListener("storage", cb);
      };
    },
    () => {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : v === "1";
      } catch {
        return fallback;
      }
    },
    () => fallback,
  );
  const set = useCallback(
    (v: boolean) => {
      try {
        localStorage.setItem(key, v ? "1" : "0");
      } catch {
        /* private mode */
      }
      window.dispatchEvent(new Event(PREF_EVENT));
    },
    [key],
  );
  return [value, set];
}

const usd = (micro: string | bigint) => {
  const cents = Number(BigInt(micro) / 10_000n);
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
};

function ConversationList({ conversations, activeId, onNavigate }: { conversations: ConversationListItem[]; activeId: string | null; onNavigate?: () => void }) {
  return (
    <div>
      <Link href="/ask" onClick={onNavigate} className="mb-3 inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent px-4 text-[14px] font-semibold text-accent-contrast hover:bg-accent-hover">
        <Plus size={16} strokeWidth={1.75} aria-hidden /> New chat
      </Link>
      {conversations.length === 0 ? (
        <p className="py-3 text-[13px] text-ink-3">No chats yet. Your conversations show up here.</p>
      ) : (
        <ul className="space-y-0.5">
          {conversations.map((c) => {
            const active = c.id === activeId;
            return (
              <li key={c.id}>
                <Link href={`/ask/${c.id}`} onClick={onNavigate} aria-current={active ? "page" : undefined} className={cx("block rounded-lg px-3 py-2.5", active ? "bg-accent-soft" : "hover:bg-paper-hover")}>
                  <span className="block truncate text-[14px] text-ink">{c.title}</span>
                  <span className="mt-0.5 block truncate text-[12px] text-ink-3">
                    {formatDay(c.updatedAt.slice(0, 10))}
                    {c.preview ? ` · ${c.preview}` : ""}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function speakText(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window) || !text) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voices = synth.getVoices();
  const pick = voices.find((v) => v.lang === "en-US" && /Samantha|Ava|Allison|Google US English/i.test(v.name)) ?? voices.find((v) => v.lang?.startsWith("en"));
  if (pick) u.voice = pick;
  u.rate = 1.02;
  synth.speak(u);
}

export function AskView({ conversations: initialConversations, turns: initialTurns, conversationId: initialId, title, status, categories }: AskViewProps) {
  const toast = useToast();
  const pathname = usePathname();
  const [turns, setTurns] = useState<AskTurnVM[]>(initialTurns);
  const [conversations, setConversations] = useState(initialConversations);
  const [conversationId, setConversationId] = useState<string | null>(initialId);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [deep, setDeep] = useState(false);
  const [speak, setSpeak] = usePref(PREF_SPEAK, false);
  const [autoSend, setAutoSend] = usePref(PREF_AUTOSEND, status.autoSendVoice);
  const [listOpen, setListOpen] = useState(false);
  const [spent, setSpent] = useState(BigInt(status.spentMicroUsd));
  const abort = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const blocked = status.blockedReason;

  useEffect(() => () => abort.current?.abort(), []);

  const scrollToEnd = () => requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }));

  const updateAssistant = useCallback((id: string, f: (t: AskTurnVM) => AskTurnVM) => setTurns((ts) => ts.map((t) => (t.id === id ? f(t) : t))), []);

  const send = useCallback(
    async (text: string) => {
      if (busy || blocked) return;
      const now = Date.now();
      const userTurn: AskTurnVM = { id: `u-${now}`, role: "user", parts: [{ type: "text", text }] };
      const aId = `a-${now}`;
      setTurns((ts) => [...ts, userTurn, { id: aId, role: "assistant", parts: [], streaming: true }]);
      setBusy(true);
      scrollToEnd();
      const ac = new AbortController();
      abort.current = ac;
      let convId = conversationId;
      try {
        const res = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: convId, message: text, deep }),
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          const j = (await res.json().catch(() => ({}))) as { message?: string };
          updateAssistant(aId, (t) => ({ ...t, streaming: false, error: j.message ?? "Ask couldn't answer right now." }));
          return;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const { messages, rest } = parseSse(buf);
          buf = rest;
          for (const m of messages) {
            let e: ClientEvent;
            try {
              e = JSON.parse(m.data) as ClientEvent;
            } catch {
              continue;
            }
            if (e.type === "conversation") {
              convId = e.id;
              setConversationId(e.id);
              if (e.created) {
                // History routing without a remount (hash routes re-prompt for the mic on iOS, §11.5).
                window.history.replaceState(null, "", `/ask/${e.id}`);
                const t = text.length > 70 ? `${text.slice(0, 67)}…` : text;
                setConversations((cs) => [{ id: e.id, title: t, updatedAt: new Date().toISOString(), preview: "" }, ...cs]);
              }
              continue;
            }
            if (e.type === "done") {
              setSpent((s) => s + BigInt(e.usage?.costMicroUsd ?? "0"));
              if (speak && e.speech) speakText(e.speech);
            }
            updateAssistant(aId, (t) => reduceTurn(t, e));
            if (e.type === "chart" || e.type === "pending_action") scrollToEnd();
          }
        }
        updateAssistant(aId, (t) => (t.streaming ? { ...t, streaming: false } : t));
        if (convId) setConversations((cs) => cs.map((c) => (c.id === convId ? { ...c, updatedAt: new Date().toISOString() } : c)));
      } catch (err) {
        const aborted = (err as Error)?.name === "AbortError";
        updateAssistant(aId, (t) => ({ ...t, streaming: false, ...(aborted ? {} : { error: `Lost the connection to ${BRAND.name}. Try again.` }) }));
      } finally {
        setBusy(false);
        abort.current = null;
        scrollToEnd();
      }
    },
    [busy, blocked, conversationId, deep, speak, updateAssistant],
  );

  async function onRecorded(rec: Recording) {
    setTranscribing(true);
    try {
      const form = new FormData();
      form.append("file", rec.blob, `speech.${rec.mimeType.includes("mp4") ? "m4a" : rec.mimeType.includes("webm") ? "webm" : "audio"}`);
      form.append("mimeType", rec.mimeType);
      const res = await fetch("/api/stt", { method: "POST", body: form });
      const j = (await res.json().catch(() => ({}))) as { text?: string; message?: string };
      if (!res.ok) {
        toast.show({ message: j.message ?? "Couldn't transcribe that.", tone: "error" });
        return;
      }
      const text = (j.text ?? "").trim();
      if (!text) {
        toast.show({ message: "Didn't catch that. Try again a little closer to the mic." });
        return;
      }
      if (autoSend && !busy && !blocked) void send(draft ? `${draft} ${text}` : text);
      else setDraft((d) => (d ? `${d} ${text}` : text));
      if (autoSend) setDraft("");
    } catch {
      toast.show({ message: "Couldn't reach the speech service.", tone: "error" });
    } finally {
      setTranscribing(false);
    }
  }

  async function saveChart(spec: ChartSpec): Promise<boolean> {
    const res = await fetch("/api/ai/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: spec.title, spec, ...(conversationId ? { conversationId } : {}) }) }).catch(() => null);
    if (res?.ok) {
      toast.show({ message: `Saved “${spec.title}” to Reports` });
      return true;
    }
    toast.show({ message: "Couldn't save that chart.", tone: "error" });
    return false;
  }

  function onActionChange(turnId: string, a: ActionVM) {
    updateAssistant(turnId, (t) => ({ ...t, parts: t.parts.map((p) => (p.type === "action" && p.action.id === a.id ? { ...p, action: a } : p)) }));
  }

  const toggleSpeak = () => {
    const next = !speak;
    setSpeak(next);
    // iOS needs speechSynthesis to be started from a tap once before it will speak later.
    if (next && typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    if (!next && typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
  };

  const activeId = conversationId ?? (pathname.startsWith("/ask/") ? pathname.slice(5) : null);
  const capPct = status.capMicroUsd !== "0" ? Number((spent * 100n) / BigInt(status.capMicroUsd)) : 0;

  return (
    <>
      <PageHeader
        title={title ?? "Ask"}
        actions={
          <button type="button" onClick={() => setListOpen(true)} className="inline-flex min-h-11 items-center gap-1.5 px-2 text-[13px] text-ink-2 lg:hidden">
            <MessagesSquare size={17} strokeWidth={1.6} aria-hidden /> Chats
          </button>
        }
      />
      <div className="lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-10 lg:px-8">
        <aside className="hidden lg:block" aria-label="Conversations">
          <ConversationList conversations={conversations} activeId={activeId} />
        </aside>
        <section aria-label="Conversation" className="flex min-h-[calc(100dvh-var(--tabbar-h)-var(--safe-bottom)-140px)] min-w-0 flex-col lg:max-w-[760px]">
          <div className="flex-1 space-y-8 px-4 pb-6 lg:px-0" aria-live="polite">
            {blocked && (
              <div role="note" className="rounded-xl bg-warn-wash px-4 py-3 text-[14px] text-ink">
                <p>{blocked}</p>
                {status.isAdmin && !status.configured && (
                  <Link href="/settings/ai" className="mt-1 inline-flex min-h-9 items-center text-[13px] font-medium text-accent underline-offset-2 hover:underline">
                    Open Settings → AI
                  </Link>
                )}
              </div>
            )}
            {turns.length === 0 ? (
              <div className="pt-4">
                <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">
                  <Sparkles size={24} strokeWidth={2} aria-hidden />
                </span>
                <p className="text-[24px] font-bold leading-tight text-ink">What do you want to know?</p>
                <p className="mt-2 text-[14px] text-ink-2">Answers come from your own data, with the date range shown. Changes always wait for your confirmation.</p>
                <h2 className="mb-2 mt-7 text-[13px] font-bold uppercase tracking-[0.05em] text-ink-3">Try asking</h2>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {SUGGESTED_PROMPTS.map((s) => (
                    <li key={s}>
                      <button type="button" disabled={!!blocked || busy} onClick={() => void send(s)} className="flex min-h-[56px] w-full items-center rounded-xl border border-rule bg-paper-raised px-4 py-2 text-left text-[14.5px] text-ink transition-colors hover:border-accent hover:bg-accent-soft disabled:cursor-default disabled:text-ink-3 disabled:hover:border-rule disabled:hover:bg-paper-raised">
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              turns.map((t) => <AskTurn key={t.id} turn={t} categories={categories} onActionChange={onActionChange} onSaveChart={saveChart} />)
            )}
            <div ref={endRef} />
          </div>
          <div className="sticky bottom-[calc(var(--tabbar-h)+var(--safe-bottom))] z-20 lg:bottom-0">
            <AskComposer
              value={draft}
              onValueChange={setDraft}
              onSend={(t) => void send(t)}
              speak={speak}
              onToggleSpeak={toggleSpeak}
              deep={deep}
              onToggleDeep={() => setDeep((d) => !d)}
              busy={busy}
              onStop={() => abort.current?.abort()}
              transcribing={transcribing}
              disabled={!!blocked}
              onRecorded={(r) => void onRecorded(r)}
              onMicError={(msg) => toast.show({ message: msg, tone: "error" })}
            />
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-paper px-4 pb-2 text-[11px] text-ink-3 lg:px-0">
              <span className="num">
                AI this month {usd(spent)} of {usd(status.capMicroUsd)}
                {capPct >= 80 && capPct < 100 ? <span className="text-warn"> · {capPct}% of the cap</span> : null}
              </span>
              <label className="inline-flex min-h-8 items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={autoSend}
                  onChange={() => setAutoSend(!autoSend)}
                  className="h-3.5 w-3.5"
                />
                Send voice questions right away
              </label>
            </div>
          </div>
        </section>
      </div>
      <Sheet open={listOpen} onClose={() => setListOpen(false)} title="Chats">
        <ConversationList conversations={conversations} activeId={activeId} onNavigate={() => setListOpen(false)} />
      </Sheet>
    </>
  );
}
