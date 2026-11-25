import { describe, expect, it } from "vitest";
import { addDays } from "@homebase/shared";
import { evaluateCategorization, type LabeledTxn } from "../src";
import { ACCOUNTS, CATS, stubAi } from "./fixtures";

let n = 0;
const L = (date: string, raw: string, dollars: number, categoryId: string | null, extra: Partial<LabeledTxn> = {}): LabeledTxn => ({
  id: `l${++n}`,
  accountId: "a-card",
  date,
  amountMilli: -BigInt(Math.round(dollars * 100)) * 10n,
  rawDescription: raw,
  categoryId,
  ...extra,
});

function dataset(): LabeledTxn[] {
  const out: LabeledTxn[] = [];
  // 6 months of training + a 60-day window starting 2026-08-23
  for (let i = 0; i < 26; i++) {
    const d = addDays("2026-03-01", i * 7);
    out.push(L(d, "KROGER #12 MILTON VA", 80 + (i % 5), "c-groc"));
    out.push(L(addDays(d, 2), "CIRCLE K 0442 FAIRVIEW VA", 40 + (i % 3), "c-gas"));
    if (i % 2 === 0) out.push(L(addDays(d, 3), "LOWE'S #1234 FAIRVIEW VA", 30 + i, "c-house"));
  }
  // Payee that only exists inside the window: history must not know it.
  out.push(L("2026-09-01", "NEW BAKERY 55", 12, "c-dining"));
  out.push(L("2026-09-08", "NEW BAKERY 55", 14, "c-dining"));
  out.push(L("2026-09-15", "NEW BAKERY 55", 11, "c-dining"));
  out.push(L("2026-09-22", "NEW BAKERY 55", 13, "c-dining"));
  // A split (excluded) and a card payment pair (transfer label)
  out.push(L("2026-09-05", "COSTCO WHSE #0123", 210, null, { isSplit: true }));
  out.push(L("2026-09-10", "FABRIKAM E-PAYMENT 1234", 500, null, { accountId: "a-chk", isTransfer: true }));
  out.push({ ...L("2026-09-11", "INTERNET PAYMENT - THANK YOU", 0, null, { accountId: "a-fab", isTransfer: true }), amountMilli: 500_000n });
  return out;
}

describe("evaluation harness (§14 Phase 4)", () => {
  it("builds history only from data before the window and reports accuracy, auto-approve rate and precision", async () => {
    const ai = stubAi({ categorize: () => ({ categoryId: "c-dining", confidence: 0.96 }) });
    const rep = await evaluateCategorization({ transactions: dataset(), windowStart: "2026-08-23", categories: CATS, accounts: ACCOUNTS, ai });
    expect(rep.windowEnd).toBe("2026-09-22");
    expect(rep.excludedSplits).toBe(1);
    expect(rep.heldOutCount).toBe(rep.evaluated + rep.excludedSplits);
    // New Bakery is never categorized by history (it only exists in the window): every one went to AI.
    const bakeryCalls = ai.calls.filter((c) => c.input.transaction.normalizedPayee.startsWith("New Bakery"));
    expect(bakeryCalls).toHaveLength(4);
    expect(bakeryCalls.every((c) => c.input.similar.every((s) => !s.payee.startsWith("New Bakery")))).toBe(true);
    expect(rep.byMethod.ai?.count).toBe(4);
    expect(rep.byMethod.transfer?.count).toBe(2);
    expect(rep.top1Accuracy).toBe(1);
    expect(rep.autoApprovePrecision).toBe(1);
    expect(rep.autoApproveRate).toBe(1);
    expect(rep.meetsTargets).toEqual({ accuracy: true, autoApproveRate: true, precision: true });
    expect(rep.costMicroUsd).toBe(4n * 125n);
  });

  it("reports mistakes and missed targets", async () => {
    const ai = stubAi({ categorize: () => ({ categoryId: "c-misc", confidence: 0.97 }) });
    const rep = await evaluateCategorization({ transactions: dataset(), windowStart: "2026-08-23", categories: CATS, accounts: ACCOUNTS, ai });
    expect(rep.mistakes.filter((m) => m.payee.startsWith("New Bakery"))).toHaveLength(4);
    expect(rep.top1Accuracy).toBeLessThan(1);
    // c-misc is always-review, so the wrong AI answers were not auto-approved
    expect(rep.autoApprovePrecision).toBe(1);
  });

  it("runs without AI (rules/history only)", async () => {
    const rep = await evaluateCategorization({ transactions: dataset(), windowStart: "2026-08-23", categories: CATS, accounts: ACCOUNTS, ai: null });
    expect(rep.aiCalls).toBe(0);
    expect(rep.mistakes.map((m) => m.predicted)).toEqual([null, null, null, null]);
  });
});
