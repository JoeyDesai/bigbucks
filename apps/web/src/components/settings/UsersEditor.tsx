"use client";
import { useState, useTransition } from "react";
import { setUserPasswordAction, setUsernameAction } from "@/server/settings/actions/admin";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { INPUT } from "./fields";
import { PASSWORD_MIN } from "@/server/identity/pin-policy";

export interface UserRow {
  id: string;
  displayName: string;
  role: "admin" | "member";
  tailscaleLogin: string | null;
  username: string | null;
  hasPassword: boolean;
  isYou: boolean;
}

/** Inline username: saves on Enter or when the field loses focus. */
function UsernameField({ u }: { u: UserRow }) {
  const toast = useToast();
  const [value, setValue] = useState(u.username ?? "");
  const [pending, start] = useTransition();
  const save = () => {
    const next = value.trim().toLowerCase();
    if (!next || next === (u.username ?? "")) return setValue(u.username ?? "");
    start(async () => {
      const r = await setUsernameAction(u.id, next);
      if (r.ok) {
        setValue(r.username ?? next);
        toast.show({ message: `${u.displayName} signs in as "${r.username ?? next}"` });
      } else {
        setValue(u.username ?? "");
        toast.show({ message: r.error, tone: "error" });
      }
    });
  };
  return (
    <input
      aria-label={`Username for ${u.displayName}`}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      placeholder="Pick a username"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      maxLength={32}
      disabled={pending}
      className={`${INPUT} h-8 max-w-[220px] font-mono text-[12px]`}
    />
  );
}

function PasswordForm({ u, onDone }: { u: UserRow; onDone: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
      onSubmit={(e) => {
        e.preventDefault();
        if (password.length < PASSWORD_MIN) return setErr(`Use at least ${PASSWORD_MIN} characters.`);
        if (password !== again) return setErr("The two passwords don't match.");
        start(async () => {
          const r = await setUserPasswordAction(u.id, password);
          if (r.ok) {
            toast.show({ message: `Password ${u.hasPassword ? "changed" : "set"} for ${u.displayName}. Their other sessions were signed out.` });
            onDone();
          } else setErr(r.error);
        });
      }}
    >
      {/* Lets a password manager save the new password under the right username. */}
      <input type="text" name="username" autoComplete="username" value={u.username ?? ""} readOnly hidden />
      <label>
        <span className="sr-only">New password for {u.displayName}</span>
        <input type="password" autoComplete="new-password" maxLength={200} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password" className={INPUT} />
      </label>
      <label>
        <span className="sr-only">Repeat password</span>
        <input type="password" autoComplete="new-password" maxLength={200} value={again} onChange={(e) => setAgain(e.target.value)} placeholder="Repeat it" className={INPUT} />
      </label>
      <Button type="submit" variant="primary" busy={pending}>
        Save password
      </Button>
      {err && (
        <p role="alert" className="text-[13px] text-neg sm:col-span-3">
          {err}
        </p>
      )}
    </form>
  );
}

/** Users & passwords: who can sign in, their username and password (argon2id), and their Tailscale login. */
export function UsersEditor({ users }: { users: UserRow[] }) {
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <ul className="border-t border-rule">
      {users.map((u) => (
        <li key={u.id} className="border-b border-rule py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="min-w-0">
              <div className="display text-[20px]">
                {u.displayName}
                {u.isYou && <span className="ml-2 font-sans text-[12px] text-ink-3">you</span>}
              </div>
              <p className="mt-0.5 text-[13px] text-ink-2">{u.role === "admin" ? "Admin: everything, including Connections, Users, AI and Backups" : "Member: budgeting, chat, categories, targets, rules, payees, memory"}</p>
              <dl className="mt-2 grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-[13px]">
                <dt className="text-ink-3">Username</dt>
                <dd className="min-w-0">
                  <UsernameField u={u} />
                </dd>
                <dt className="text-ink-3">Password</dt>
                <dd className={u.hasPassword ? "text-ink" : "text-ink-3"}>{u.hasPassword ? "Set" : "Not set"}</dd>
                <dt className="text-ink-3">Tailscale login</dt>
                <dd className="truncate font-mono text-[12px]">{u.tailscaleLogin ?? <span className="font-sans text-ink-3">none</span>}</dd>
              </dl>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setOpen(open === u.id ? null : u.id)}>
                {u.hasPassword ? "Change password" : "Set password"}
              </Button>
              {u.hasPassword && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() =>
                    window.confirm(`Remove ${u.displayName}'s password? They can't sign in with a password until a new one is set.`) &&
                    start(async () => {
                      const r = await setUserPasswordAction(u.id, null);
                      toast.show(r.ok ? { message: `Password removed for ${u.displayName}` } : { message: r.error, tone: "error" });
                    })
                  }
                >
                  Remove password
                </Button>
              )}
            </div>
          </div>
          {open === u.id && <PasswordForm u={u} onDone={() => setOpen(null)} />}
          {open === u.id && u.isYou && <p className="mt-2 text-[12px] text-ink-3">Changing your own password signs you out everywhere you signed in with it, including here.</p>}
        </li>
      ))}
    </ul>
  );
}
