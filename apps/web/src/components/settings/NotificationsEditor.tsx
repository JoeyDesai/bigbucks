"use client";
import { BRAND } from "@/lib/brand";
import { useEffect, useState, useTransition } from "react";
import { setPushPreferenceAction } from "@/server/settings/actions/notifications";
import { setVapidSubjectAction } from "@/server/settings/actions/admin";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { SettingsSection } from "./SettingsFrame";
import { FormStatus, TextField, ToggleRow } from "./fields";

export interface AlertPref {
  type: string;
  label: string;
  admin: boolean;
  enabled: boolean;
}

type DeviceState = "checking" | "unsupported" | "ios-browser" | "denied" | "off" | "on" | "no-sw";

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

async function registration(timeoutMs = 4000): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing;
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
}

function DeviceToggle({ deviceCount }: { deviceCount: number }) {
  const toast = useToast();
  const [state, setState] = useState<DeviceState>("checking");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      if (isIos() && !isStandalone()) return setState("ios-browser");
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return setState("unsupported");
      if (Notification.permission === "denied") return setState("denied");
      const reg = await registration(1500);
      if (!reg) return setState("no-sw");
      const sub = await reg.pushManager.getSubscription();
      setState(sub ? "on" : "off");
    })().catch(() => setState("unsupported"));
  }, []);

  async function enable() {
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState(perm === "denied" ? "denied" : "off");
        return;
      }
      const reg = await registration();
      if (!reg) return setState("no-sw");
      const keyRes = await fetch("/api/push/subscribe");
      const k = (await keyRes.json()) as { publicKey?: string; message?: string };
      if (!keyRes.ok || !k.publicKey) throw new Error(k.message ?? "Push keys aren't available.");
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(k.publicKey) }));
      const res = await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
      if (!res.ok) throw new Error("Couldn't save this device.");
      setState("on");
      toast.show({ message: "Notifications are on for this device" });
    } catch (e) {
      toast.show({ message: e instanceof Error ? e.message : "Couldn't turn on notifications.", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const reg = await registration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
        await sub.unsubscribe();
      }
      setState("off");
      toast.show({ message: "Notifications are off for this device" });
    } finally {
      setBusy(false);
    }
  }

  const note: Record<DeviceState, string> = {
    checking: "Checking this device…",
    unsupported: "This browser doesn't support Web Push.",
    "ios-browser": `On iPhone and iPad, notifications only work in the installed app. In Safari, tap Share → Add to Home Screen, open ${BRAND.name} from the Home Screen, then come back here.`,
    denied: `Notifications are blocked for ${BRAND.name}. Allow them in the system settings for this app, then reload.`,
    "no-sw": "The offline worker isn't running here (it's off in development builds), so this device can't receive push.",
    off: "This device isn't receiving notifications.",
    on: "This device receives notifications.",
  };
  return (
    <div className="border-t border-rule pt-4">
      <p className="text-[14px] text-ink-2">{note[state]}</p>
      <p className="num mt-1 text-[12px] text-ink-3">
        {deviceCount} device{deviceCount === 1 ? "" : "s"} signed up for you.
      </p>
      <div className="mt-3">
        {state === "on" ? (
          <Button onClick={() => void disable()} busy={busy}>
            Turn off on this device
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void enable()} busy={busy} disabled={state !== "off"}>
            Enable notifications on this device
          </Button>
        )}
      </div>
    </div>
  );
}

export function NotificationsEditor({ prefs, deviceCount, isAdmin, vapidSubject }: { prefs: AlertPref[]; deviceCount: number; isAdmin: boolean; vapidSubject: string | null }) {
  const toast = useToast();
  const [state, setState] = useState(prefs);
  const [, start] = useTransition();
  const [subject, setSubject] = useState(vapidSubject ?? "");
  const [subjectResult, setSubjectResult] = useState<{ ok: true } | { ok: false; error: string } | null>(null);
  return (
    <>
      <SettingsSection id="device" title="This device">
        <DeviceToggle deviceCount={deviceCount} />
      </SettingsSection>
      <SettingsSection id="alerts" title="Alerts" description="Each one can be turned off. These are your own settings; the other person sets theirs.">
        <div className="border-t border-rule">
          {state
            .filter((p) => isAdmin || !p.admin)
            .map((p) => (
              <ToggleRow
                key={p.type}
                label={p.label}
                description={p.admin ? "Admin only" : undefined}
                checked={p.enabled}
                onChange={(v) => {
                  setState((s) => s.map((x) => (x.type === p.type ? { ...x, enabled: v } : x)));
                  start(async () => {
                    const r = await setPushPreferenceAction(p.type, v);
                    if (!r.ok) {
                      setState((s) => s.map((x) => (x.type === p.type ? { ...x, enabled: !v } : x)));
                      toast.show({ message: r.error, tone: "error" });
                    }
                  });
                }}
              />
            ))}
        </div>
      </SettingsSection>
      {isAdmin && (
        <SettingsSection id="vapid" title="Push sender" description="Apple requires a real contact address in the push keys (VAPID subject).">
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              start(async () => setSubjectResult(await setVapidSubjectAction(subject)));
            }}
          >
            <TextField label="Contact" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="mailto:you@example.com" className="min-w-[260px] flex-1" disabled={vapidSubject === null} />
            <Button type="submit" disabled={vapidSubject === null}>
              Save
            </Button>
          </form>
          <div className="mt-2">
            <FormStatus result={subjectResult} />
          </div>
          {vapidSubject === null && <p className="mt-2 text-[12px] text-ink-3">Push keys haven&rsquo;t been created yet (they need HOMEBASE_MASTER_KEY on the server).</p>}
        </SettingsSection>
      )}
    </>
  );
}
