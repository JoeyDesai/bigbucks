"use client";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { useLastAppPage } from "@/components/shell/LastAppPage";

/** "‹ Back to Budget": returns to the page the guide was opened from. */
export function GuideBack() {
  const back = useLastAppPage();
  return (
    <Link href={back.href} className="-ml-1 mb-3 inline-flex min-h-10 items-center gap-1 rounded-full pr-3 text-[14px] font-semibold text-accent hover:underline" data-testid="guide-back">
      <ChevronLeft size={17} strokeWidth={2} aria-hidden /> Back to {back.label}
    </Link>
  );
}
