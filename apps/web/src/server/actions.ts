"use server";
import { redirect } from "next/navigation";
import { z } from "zod";
import { signInWithPassword, signOut, type SignInResult } from "./auth";
import { safeNext } from "./safe-next";

const LoginForm = z.object({
  username: z.string().max(100),
  password: z.string().max(200),
  next: z.string().max(512).optional(),
});

export async function passwordSignInAction(_prev: SignInResult | null, form: FormData): Promise<SignInResult> {
  const parsed = LoginForm.safeParse({ username: form.get("username"), password: form.get("password"), next: form.get("next") ?? undefined });
  if (!parsed.success || !parsed.data.username.trim() || !parsed.data.password) return { ok: false, error: "Enter your username and password." };
  const r = await signInWithPassword(parsed.data.username, parsed.data.password);
  if (r.ok) redirect(safeNext(parsed.data.next));
  return r;
}

export async function signOutAction(): Promise<void> {
  await signOut();
  redirect("/login");
}
