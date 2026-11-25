/** Pure display logic for budget rows — no React, unit tested. */
import { formatMilli } from "@homebase/shared";
import type { AvailableState, CategoryVM } from "./view-models";

export type Tone = "pos" | "neg" | "warn" | "zero" | "ink" | "muted";

export function availableState(c: Pick<CategoryVM, "available" | "cashOverspend" | "creditOverspend" | "upcoming" | "target" | "pill">): AvailableState {
  if (c.pill) {
    if (c.pill === "red") return "cash_overspent";
    if (c.pill === "yellow") return c.available < 0n ? "credit_overspent" : "upcoming";
    if (c.pill === "green") return "funded";
    return "zero";
  }
  if (c.available < 0n) {
    // Mixed overspending shows red (YNAB rule, spec §6.3). Default to cash when unknown.
    const cash = c.cashOverspend ?? (c.creditOverspend !== undefined ? -c.available - c.creditOverspend : -c.available);
    return cash > 0n ? "cash_overspent" : "credit_overspent";
  }
  const underfunded = c.target && !c.target.snoozed ? c.target.underfunded : 0n;
  if (underfunded > 0n && (c.upcoming ?? 0n) > 0n) return "upcoming";
  if (c.available === 0n) return "zero";
  return "funded";
}

export const STATE_TONE: Record<AvailableState, Tone> = {
  funded: "pos",
  zero: "zero",
  credit_overspent: "warn",
  cash_overspent: "neg",
  upcoming: "warn",
};

export const STATE_LABEL: Record<AvailableState, string> = {
  funded: "Money available",
  zero: "Nothing available",
  credit_overspent: "Credit overspending",
  cash_overspent: "Cash overspending",
  upcoming: "Upcoming needs money",
};

/** Pill look for an Available amount (YNAB): tone, and an icon for "target met" and "credit overspending". */
export interface PillLook {
  tone: "pos" | "zero" | "warn" | "neg";
  icon: "check" | "card" | null;
}

export function availablePill(c: CategoryVM): PillLook {
  const state = availableState(c);
  if (state === "cash_overspent") return { tone: "neg", icon: null };
  if (state === "credit_overspent") return { tone: "warn", icon: "card" };
  if (state === "upcoming") return { tone: "warn", icon: null };
  if (state === "zero") return { tone: "zero", icon: null };
  const met = !!c.target && !c.target.snoozed && c.target.underfunded === 0n && c.target.needed > 0n;
  return { tone: "pos", icon: met ? "check" : null };
}

export interface TargetProgress {
  /** 0..1 share of the target covered by Assigned + carry-in. */
  funded: number;
  /** 0..1 share of the target already spent. */
  spent: number;
  tone: Tone;
  label: string;
}

const ratio = (a: bigint, b: bigint): number => {
  if (b <= 0n) return a > 0n ? 1 : 0;
  const r = Number((a * 10000n) / b) / 10000;
  return Math.max(0, Math.min(1, r));
};

/**
 * Status label + progress for the thin target bar (spec §12.1, YNAB wording):
 * "Funded", "Fully Spent", "Funded. Spent $X of $Y", "Overspent. $X of $Y", "$X more needed by …", "Snoozed".
 */
export function targetProgress(c: CategoryVM): TargetProgress | null {
  const t = c.target;
  if (!t) return null;
  if (t.snoozed) return { funded: 0, spent: 0, tone: "muted", label: "Snoozed" };
  const goal = t.needed > 0n ? t.needed : t.amount;
  const spent = c.activity < 0n ? -c.activity : 0n;
  const fundedAmt = goal - t.underfunded;

  if (c.available < 0n) {
    const state = availableState(c);
    return {
      funded: 1,
      spent: 1,
      tone: STATE_TONE[state],
      label: `Overspent. ${formatMilli(spent)} of ${formatMilli(goal)}`,
    };
  }
  if (t.underfunded > 0n) {
    return {
      funded: ratio(fundedAmt, goal),
      spent: ratio(spent, goal),
      tone: (c.upcoming ?? 0n) > 0n ? "warn" : "muted",
      label: `${formatMilli(t.underfunded)} more needed${t.dueLabel ? ` by ${t.dueLabel}` : " this month"}`,
    };
  }
  if (spent > 0n && c.available === 0n) return { funded: 1, spent: 1, tone: "zero", label: "Fully Spent" };
  if (spent > 0n) {
    return { funded: 1, spent: ratio(spent, goal), tone: "pos", label: `Funded. Spent ${formatMilli(spent)} of ${formatMilli(goal)}` };
  }
  return { funded: 1, spent: 0, tone: "pos", label: "Funded" };
}

/** Tone for a plain signed amount: green positive, red negative, gray zero. */
export function signedTone(m: bigint): Tone {
  return m > 0n ? "pos" : m < 0n ? "neg" : "zero";
}

export function rtaTone(m: bigint): Tone {
  return signedTone(m);
}
