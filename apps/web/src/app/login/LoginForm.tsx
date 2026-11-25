"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { cx } from "@/lib/cx";
import { passwordSignInAction } from "@/server/actions";
import type { SignInResult } from "@/server/auth";
import { Button } from "@/components/ui/Button";

const FIELD = "mt-1.5 h-12 w-full rounded-[10px] border border-rule-strong bg-paper px-3 text-[16px] text-ink outline-none transition-colors focus-visible:border-accent";

/** Username + password. Password managers fill both (autocomplete username / current-password). */
export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<SignInResult | null, FormData>(passwordSignInAction, null);
  const passwordRef = useRef<HTMLInputElement>(null);
  // Controlled so a wrong password doesn't wipe the username too (form actions reset uncontrolled fields).
  const [username, setUsername] = useState("");

  useEffect(() => {
    if (state && !state.ok && passwordRef.current) {
      passwordRef.current.value = "";
      passwordRef.current.focus();
    }
  }, [state]);

  const locked = state && !state.ok && state.lockedMinutes;
  return (
    <form action={action} className="mt-5 space-y-4">
      <input type="hidden" name="next" value={next} />
      <label className="block">
        <span className="text-[14px] font-semibold text-ink">Username</span>
        <input name="username" type="text" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required autoFocus maxLength={100} disabled={pending} className={FIELD} />
      </label>
      <label className="block">
        <span className="text-[14px] font-semibold text-ink">Password</span>
        <input
          ref={passwordRef}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={200}
          disabled={pending || !!locked}
          aria-invalid={state && !state.ok ? true : undefined}
          aria-describedby="login-msg"
          className={FIELD}
        />
      </label>
      <Button type="submit" variant="primary" busy={pending} disabled={!!locked} className="h-12 w-full text-[16px]">
        Sign in
      </Button>
      <p id="login-msg" role="status" className={cx("min-h-[40px] text-[14px]", state && !state.ok ? "text-neg" : "text-ink-3")}>
        {state && !state.ok ? (
          <>
            {state.error}
            {state.lockedMinutes ? ` Try again in ${state.lockedMinutes} min.` : state.remaining !== undefined && state.remaining <= 3 ? ` ${state.remaining} ${state.remaining === 1 ? "try" : "tries"} left before a 15-minute lock.` : ""}
          </>
        ) : (
          "Stays signed in on this device for 30 days."
        )}
      </p>
    </form>
  );
}
