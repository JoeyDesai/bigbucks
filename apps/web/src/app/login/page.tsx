import { redirect } from "next/navigation";
import { Mark } from "@/components/shell/Mark";
import { BRAND } from "@/lib/brand";
import { getCurrentUser } from "@/server/auth";
import { env } from "@/server/env";
import { safeNext } from "@/server/safe-next";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const dest = safeNext(next);
  if (await getCurrentUser()) redirect(dest);
  const demoUrl = env().HOMEBASE_DEMO_URL;
  return (
    <main className="flex min-h-dvh w-full flex-col items-center bg-nav px-4 pb-[calc(24px+var(--safe-bottom))] pt-[calc(40px+var(--safe-top))]">
      <div className="flex items-center gap-3 text-white">
        <Mark size={44} className="rounded-[12px] ring-1 ring-white/20" />
        <span className="text-[28px] font-extrabold tracking-[-0.02em]">{BRAND.name}</span>
      </div>
      <div className="mt-8 w-full max-w-[400px] rounded-2xl bg-paper p-6 shadow-pop">
        <h1 className="text-[26px] font-bold leading-tight text-ink">Sign in</h1>
        <LoginForm next={dest} />
      </div>
      {demoUrl && (
        <a href={demoUrl} className="mt-5 text-[14px] font-semibold text-white/85 underline decoration-white/30 underline-offset-4 hover:text-white hover:decoration-white">
          Just looking? Try the demo with made-up money
        </a>
      )}
      <p className="mt-6 text-[13px] text-white/60">{BRAND.tagline}</p>
    </main>
  );
}
