"use client";
import { BRAND } from "@/lib/brand";
import { useState, useTransition } from "react";
import Link from "next/link";
import { saveConnectionCredentialsAction, setConnectionDisabledAction, testConnectionAction } from "@/server/settings/actions/admin";
import { timeAgo } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Sheet } from "@/components/ui/Sheet";
import { StatusDot } from "@/components/ui/StatusDot";
import { useToast } from "@/components/ui/Toast";
import { TextArea, TextField } from "./fields";

export interface ConnectionRow {
  id: string;
  provider: string;
  providerLabel: string;
  label: string;
  status: "ok" | "needs_attention" | "error" | "disabled";
  lastSuccessAt: string | null;
  lastError: string | null;
  last4: string | null;
  hasCredentials: boolean;
  requestsToday: number;
  manualToday: number;
  lastRun: { startedAt: string; status: string; added: number; updated: number } | null;
  issues: string[];
  inboxCount: number;
}

type Provider = "simplefin" | "mercury" | "coinbase" | "rentcast" | "ynab";

const HELP: Record<Provider, { title: string; steps: string[] }> = {
  simplefin: {
    title: "SimpleFIN Bridge",
    steps: [
      "In SimpleFIN Bridge (beta-bridge.simplefin.org), open My Account and choose New Connection → Create setup token.",
      `Paste the token here. ${BRAND.name} claims it once and stores the resulting access URL encrypted. A setup token can only be claimed once.`,
      "To reconnect a bank, fix it inside SimpleFIN Bridge; the access URL stays the same.",
    ],
  },
  mercury: { title: "Mercury", steps: ["In Mercury, Settings → API Tokens → create a read-only token.", `Paste it here. ${BRAND.name} only reads accounts and transactions.`] },
  coinbase: {
    title: "Coinbase",
    steps: ["In the Coinbase Developer Platform, create a Secret API key with view permission only.", "Paste the key name (organizations/…/apiKeys/…) and the EC private key PEM."],
  },
  rentcast: { title: "RentCast", steps: ["Create an API key in the RentCast dashboard.", "Valuations run monthly; the free tier allows a few calls a month, so the Test button doesn't spend one."] },
  ynab: { title: "YNAB (migration)", steps: ["In YNAB, Account Settings → Developer Settings → New Token.", "Used only for the read-only import and the daily parallel-run deltas until cutover."] },
};

function CredentialForm({ provider, connectionId, onDone }: { provider: Provider; connectionId?: string; onDone: () => void }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [v, setV] = useState({ setupToken: "", token: "", apiKey: "", keyName: "", privateKeyPem: "", label: "" });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof v, x: string) => setV((s) => ({ ...s, [k]: x }));
  const submit = () =>
    start(async () => {
      setErr(null);
      const base = { ...(connectionId ? { connectionId } : {}), ...(v.label.trim() ? { label: v.label.trim() } : {}) };
      const input =
        provider === "simplefin"
          ? { provider, ...base, setupToken: v.setupToken }
          : provider === "mercury" || provider === "ynab"
            ? { provider, ...base, token: v.token }
            : provider === "rentcast"
              ? { provider, ...base, apiKey: v.apiKey }
              : { provider, ...base, keyName: v.keyName, privateKeyPem: v.privateKeyPem };
      const r = await saveConnectionCredentialsAction(input);
      if (r.ok) {
        setV({ setupToken: "", token: "", apiKey: "", keyName: "", privateKeyPem: "", label: "" });
        toast.show({ message: `${HELP[provider].title} saved (ending ${r.last4 || "…"})` });
        onDone();
      } else setErr(r.error);
    });
  const h = HELP[provider];
  return (
    <form
      className="space-y-4"
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <ol className="space-y-1.5 text-[13px] text-ink-2">
        {h.steps.map((s, i) => (
          <li key={i} className="flex gap-2">
            <span className="num w-4 shrink-0 text-ink-3">{i + 1}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
      {!connectionId && <TextField label="Label (optional)" value={v.label} onChange={(e) => set("label", e.target.value)} placeholder={h.title} maxLength={80} />}
      {provider === "simplefin" && <TextArea mono label="Setup token" value={v.setupToken} onChange={(e) => set("setupToken", e.target.value)} spellCheck={false} rows={3} />}
      {(provider === "mercury" || provider === "ynab") && <TextField label="API token" type="password" value={v.token} onChange={(e) => set("token", e.target.value)} spellCheck={false} />}
      {provider === "rentcast" && <TextField label="API key" type="password" value={v.apiKey} onChange={(e) => set("apiKey", e.target.value)} spellCheck={false} />}
      {provider === "coinbase" && (
        <>
          <TextField label="Key name" value={v.keyName} onChange={(e) => set("keyName", e.target.value)} spellCheck={false} placeholder="organizations/…/apiKeys/…" />
          <TextArea mono label="Private key (PEM)" value={v.privateKeyPem} onChange={(e) => set("privateKeyPem", e.target.value)} spellCheck={false} rows={5} placeholder="-----BEGIN EC PRIVATE KEY-----" />
        </>
      )}
      <p className="text-[12px] text-ink-3">Stored encrypted on the server. {BRAND.name} only ever shows the last 4 characters.</p>
      {err && (
        <p role="alert" className="text-[13px] text-neg">
          {err}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" busy={pending}>
          {provider === "simplefin" ? "Claim and save" : "Save"}
        </Button>
      </div>
    </form>
  );
}

const fmtWhen = (iso: string | null) => (iso ? timeAgo(iso) : "never");

export function ConnectionsEditor({ connections, anthropic }: { connections: ConnectionRow[]; anthropic: { configured: boolean; source: string | null } }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [testing, setTesting] = useState<string | null>(null);
  const [rotate, setRotate] = useState<ConnectionRow | null>(null);
  const [addProvider, setAddProvider] = useState<Provider>("simplefin");

  return (
    <>
      {connections.length === 0 ? (
        <p className="mb-10 border-t border-rule py-6 text-[14px] text-ink-3">No connections yet. Add SimpleFIN first: it brings in your bank, card and brokerage accounts.</p>
      ) : (
        <ul className="mb-12 border-t border-rule">
          {connections.map((c) => (
            <li key={c.id} className="border-b border-rule py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[16px] text-ink">{c.label}</span>
                    <StatusDot status={c.status} showLabel />
                  </div>
                  <p className="num mt-0.5 text-[12px] text-ink-3">
                    {c.providerLabel} · last success {fmtWhen(c.lastSuccessAt)}
                    {c.last4 ? ` · key ••••${c.last4}` : c.hasCredentials ? "" : " · no credentials"}
                    {c.provider === "simplefin" ? ` · ${c.requestsToday} of 6 requests today (${c.manualToday} of 2 manual)` : ""}
                  </p>
                  {c.lastRun && (
                    <p className="num mt-0.5 text-[12px] text-ink-3">
                      Last run {fmtWhen(c.lastRun.startedAt)}: {c.lastRun.status}, {c.lastRun.added} added, {c.lastRun.updated} updated
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    disabled={!c.hasCredentials || c.status === "disabled"}
                    busy={testing === c.id}
                    title={c.provider === "simplefin" ? "Uses one of today's 6 SimpleFIN requests" : undefined}
                    onClick={() => {
                      setTesting(c.id);
                      start(async () => {
                        const r = await testConnectionAction(c.id);
                        setTesting(null);
                        if (r.ok) toast.show({ message: r.result.message, tone: r.result.ok ? "default" : "error" });
                        else toast.show({ message: r.error, tone: "error" });
                      });
                    }}
                  >
                    Test
                  </Button>
                  {c.provider in HELP && (
                    <Button size="sm" onClick={() => setRotate(c)}>
                      {c.hasCredentials ? "Rotate key" : "Add key"}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      start(async () => {
                        const r = await setConnectionDisabledAction(c.id, c.status !== "disabled");
                        if (!r.ok) toast.show({ message: r.error, tone: "error" });
                      })
                    }
                  >
                    {c.status === "disabled" ? "Enable" : "Disable"}
                  </Button>
                </div>
              </div>
              {(c.issues.length > 0 || (c.lastError && c.status !== "ok")) && (
                <div className="mt-2 border-l-[3px] border-warn-bar pl-3 text-[13px] text-ink-2">
                  {c.issues.map((i) => (
                    <p key={i}>{i}</p>
                  ))}
                  {c.lastError && c.status !== "ok" && <p>{c.lastError}</p>}
                  {c.provider === "simplefin" && <p className="mt-1 text-ink-3">Reconnect the bank inside SimpleFIN Bridge; {BRAND.name} picks it up on the next sync.</p>}
                </div>
              )}
              {c.inboxCount > 0 && (
                <p className="mt-2 text-[13px]">
                  <Link href="/activity" className="text-accent underline-offset-2 hover:underline">
                    {c.inboxCount} new account{c.inboxCount === 1 ? "" : "s"} waiting in the inbox on Activity
                  </Link>
                </p>
              )}
            </li>
          ))}
          <li className="border-b border-rule py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[16px] text-ink">Anthropic (Ask and categorization)</span>
                  <StatusDot status={anthropic.configured ? "ok" : "disabled"} showLabel />
                </div>
                <p className="mt-0.5 text-[12px] text-ink-3">{anthropic.configured ? (anthropic.source === "env" ? "From ANTHROPIC_API_KEY on the server" : "Stored encrypted in Settings") : "No key yet"}</p>
              </div>
              <Link href="/settings/ai" className="inline-flex min-h-9 items-center rounded-sm border border-rule-strong px-3 text-[13px] font-medium hover:border-accent">
                Manage in AI settings
              </Link>
            </div>
          </li>
        </ul>
      )}

      <section aria-labelledby="add-h">
        <h2 id="add-h" className="display mb-3 text-[21px]">
          Add a connection
        </h2>
        <SegmentedControl
          variant="underline"
          label="Provider"
          value={addProvider}
          onChange={setAddProvider}
          className="mb-5"
          options={[
            { value: "simplefin", label: "SimpleFIN" },
            { value: "mercury", label: "Mercury" },
            { value: "coinbase", label: "Coinbase" },
            { value: "rentcast", label: "RentCast" },
            { value: "ynab", label: "YNAB" },
          ]}
        />
        <CredentialForm key={addProvider} provider={addProvider} onDone={() => undefined} />
      </section>

      <Sheet open={!!rotate} onClose={() => setRotate(null)} title={rotate ? `${rotate.hasCredentials ? "Rotate" : "Add"} ${rotate.providerLabel} key` : "Rotate key"} description="The old credential is replaced immediately.">
        {rotate && <CredentialForm provider={rotate.provider as Provider} connectionId={rotate.id} onDone={() => setRotate(null)} />}
      </Sheet>
    </>
  );
}
