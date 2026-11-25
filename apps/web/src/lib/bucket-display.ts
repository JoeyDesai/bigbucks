/**
 * What a bucket row says (pure, unit-tested). Money is bigint milliunits; the bar comes from core's
 * `bucketBar` except for savings goals, which show progress toward the balance instead.
 */
import { divRound, formatMilli, parseMilli, type Milli } from "@homebase/shared";
import type { BucketRow } from "@homebase/core";
import type { BarModel } from "@/components/glow/BucketBar";

export type Tone = "ink" | "over" | "warn" | "muted";

export interface RowDisplay {
  bar: BarModel;
  /** Right side, big: "$124 left" / "$42 over" / "$45 spent". */
  amount: Milli;
  amountSuffix: string;
  tone: Tone;
  /** Under the bar: "$826 of $950 spent". */
  detail: string;
  /** Screen-reader summary for the bar. */
  label: string;
  savings: boolean;
  /** Spent exactly the budget (a paid bill): shown as done, not as a warning. */
  done?: boolean;
  /** Overflow buckets: "$50 goal + $175 rolled over" (null when rollover is off). */
  rollover: string | null;
}

type RowInput = Pick<BucketRow, "bar" | "budget" | "spent" | "remaining" | "goal" | "available" | "name"> & Partial<Pick<BucketRow, "rollover" | "carryIn" | "goalAmount">>;

/** "$50 goal + $175 rolled over" · "$50 goal, leftovers roll over" · "$175 rolled over" (no goal). */
export function rolloverText(r: { rollover?: boolean; carryIn?: Milli; goalAmount?: Milli | null }): string | null {
  if (!r.rollover) return null;
  const carry = r.carryIn ?? 0n;
  const goal = r.goalAmount ?? null;
  if (goal === null) return carry > 0n ? `${money(carry)} rolled over` : "Leftovers roll over";
  return carry > 0n ? `${money(goal)} goal + ${money(carry)} rolled over` : `${money(goal)} goal, leftovers roll over`;
}

/** Whole dollars, rounded ($79.99 → $80). */
const money = (m: Milli) => formatMilli(divRound(m < 0n ? -m : m, 1000n) * 1000n, { cents: false });
const cents = (m: Milli) => formatMilli(m < 0n ? -m : m);
const share = (a: Milli, b: Milli) => (b <= 0n ? 0 : Math.max(0, Math.min(1, Number((a * 10_000n) / b) / 10_000)));

export function rowDisplay(r: RowInput): RowDisplay {
  const rollover = r.goal?.kind === "balance" ? null : rolloverText(r);
  if (r.goal?.kind === "balance" && r.budget) {
    const saved = r.available > 0n ? r.available : 0n;
    const fill = share(saved, r.budget);
    return {
      bar: { state: "under", fill, over: 0 },
      amount: saved,
      amountSuffix: "saved",
      tone: "ink",
      detail: `${Math.round(fill * 100)}% of ${money(r.budget)} goal`,
      label: `${r.name}: ${cents(saved)} saved toward ${cents(r.budget)}`,
      savings: true,
      rollover: null,
    };
  }
  const b = r.bar;
  if (b.state === "none" || r.budget === null) {
    return {
      bar: { state: "none", fill: 0, over: 0 },
      amount: r.spent > 0n ? r.spent : 0n,
      amountSuffix: "spent",
      tone: r.spent > 0n ? "ink" : "muted",
      detail: "No monthly goal",
      label: `${r.name}: ${cents(r.spent)} spent, no goal`,
      savings: false,
      rollover,
    };
  }
  if (b.state === "over") {
    return {
      bar: b,
      amount: -r.remaining,
      amountSuffix: "over",
      tone: "over",
      detail: `${money(r.spent)} of ${money(r.budget)} spent`,
      label: `${r.name}: ${cents(-r.remaining)} over a ${cents(r.budget)} budget`,
      savings: false,
      rollover,
    };
  }
  // a paid bill (or within a dollar of it)
  if (r.remaining >= 0n && r.remaining < 1000n && r.spent > 0n)
    return {
      bar: b,
      amount: 0n,
      amountSuffix: "left",
      tone: "muted",
      detail: `All ${money(r.budget)} spent`,
      label: `${r.name}: all of ${cents(r.budget)} spent`,
      savings: false,
      done: true,
      rollover,
    };
  return {
    bar: b,
    amount: r.remaining,
    amountSuffix: "left",
    tone: b.state === "warn" ? "warn" : "ink",
    detail: `${money(r.spent > 0n ? r.spent : 0n)} of ${money(r.budget)} spent`,
    label: `${r.name}: ${cents(r.remaining)} left of ${cents(r.budget)}`,
    savings: false,
    rollover,
  };
}

export type PaceTone = "ahead" | "on_pace" | "behind" | "none";

/** "Spending faster than the month" / "Right on pace" / "Under pace", from core's monthPace. */
export function paceText(status: PaceTone, spentRatio: number, elapsed: number): { title: string; detail: string } {
  const sp = Math.round(spentRatio * 100);
  const el = Math.round(elapsed * 100);
  switch (status) {
    case "ahead":
      return { title: "Ahead of pace", detail: `${sp}% spent with ${el}% of the month gone` };
    case "behind":
      return { title: "Under pace", detail: `${sp}% spent with ${el}% of the month gone` };
    case "on_pace":
      return { title: "On pace", detail: `${sp}% spent with ${el}% of the month gone` };
    default:
      return { title: elapsed === 0 ? "Month hasn't started" : "No goals yet", detail: "" };
  }
}

/** "$950" → 950000n; null when it isn't a positive amount. */
export function parseGoalText(text: string): bigint | null {
  const t = text.replace(/[$,\s]/g, "");
  if (!/^\d*\.?\d{0,2}$/.test(t) || t === "" || t === ".") return null;
  try {
    const v = parseMilli(t);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

