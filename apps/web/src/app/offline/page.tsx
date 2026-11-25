import { Mark } from "@/components/shell/Mark";
import { BRAND } from "@/lib/brand";

export const dynamic = "force-static";
export const metadata = { title: "Offline" };

/** Precached fallback shown by the service worker when a navigation fails. */
export default function Offline() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 pt-[var(--safe-top)]">
      <Mark size={48} />
      <h1 className="mt-6 text-[30px] font-bold leading-tight">Can’t reach {BRAND.name}</h1>
      <p className="mt-3 text-[15px] text-ink-2">
        {BRAND.name} lives on the home server and only answers over Tailscale. Check that Tailscale is connected on this device, then try again.
      </p>
      <p className="mt-2 text-[13px] text-ink-3">Nothing is stored on this phone, so there is no offline copy of your budget.</p>
      <a href="/budget" className="mt-8 inline-flex min-h-11 w-fit items-center rounded-md bg-accent px-5 text-[15px] font-semibold text-accent-contrast">
        Try again
      </a>
    </main>
  );
}
