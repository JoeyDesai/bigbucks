import { describe, expect, it } from "vitest";
import { decideApproval, defaultAlwaysReview, DEFAULT_APPROVAL_SETTINGS, type ApprovalInput } from "../src";
import { CATS } from "./fixtures";

const settings = { ...DEFAULT_APPROVAL_SETTINGS, alwaysReviewCategoryIds: defaultAlwaysReview(CATS) };
const base: ApprovalInput = { method: "history", confidence: 0.96, amountMilli: -40_000n, categoryIds: ["c-groc"], toReadyToAssign: false, priorReviewedForPayee: 99 };
const d = (o: Partial<ApprovalInput>) => decideApproval({ ...base, ...o }, settings);

describe("approval policy (§9.4)", () => {
  it("defaults always-review to Misc, Uncategorized and Savings categories", () => {
    expect(defaultAlwaysReview(CATS).sort()).toEqual(["c-emerg", "c-misc", "c-unc"]);
  });

  it.each([
    ["history 0.96", { method: "history", confidence: 0.96 }, true, true],
    ["history 0.94", { method: "history", confidence: 0.94 }, true, false],
    ["rule 1.0", { method: "rule", confidence: 1 }, true, true],
    ["ai 0.96 $40", { method: "ai", confidence: 0.96 }, true, true],
    ["ai 0.96 $150 (not < $150)", { method: "ai", confidence: 0.96, amountMilli: -150_000n }, true, false],
    ["ai_web 0.97 $149.99", { method: "ai_web", confidence: 0.97, amountMilli: -149_990n }, true, true],
    ["ai 0.80", { method: "ai", confidence: 0.8 }, true, false],
    ["ai 0.75 categorizes", { method: "ai", confidence: 0.75 }, true, false],
    ["ai 0.74 suggests only", { method: "ai", confidence: 0.74 }, false, false],
    ["always-review Misc", { method: "rule", confidence: 1, categoryIds: ["c-misc"] }, true, false],
    ["always-review Savings via split line", { method: "history", confidence: 0.98, categoryIds: ["c-groc", "c-emerg"] }, true, false],
    ["transfer", { method: "transfer", confidence: 0.99, categoryIds: [] }, true, true],
    ["rule auto-approve beats always-review", { method: "rule", confidence: 1, categoryIds: ["c-misc"], ruleAutoApprove: true }, true, true],
    ["rule says review", { method: "rule", confidence: 1, ruleAutoApprove: false }, true, false],
  ] as const)("%s", (_n, o, categorize, approve) => {
    const r = d(o as Partial<ApprovalInput>);
    expect(r.categorize).toBe(categorize);
    expect(r.approve).toBe(approve);
  });

  it("income over $500 and Ready to Assign need review the first 3 times per payee", () => {
    expect(d({ method: "history", confidence: 0.98, amountMilli: 2_500_000n, categoryIds: ["c-rta"], toReadyToAssign: true, priorReviewedForPayee: 2 }).approve).toBe(false);
    expect(d({ method: "history", confidence: 0.98, amountMilli: 2_500_000n, categoryIds: ["c-rta"], toReadyToAssign: true, priorReviewedForPayee: 3 }).approve).toBe(true);
    expect(d({ method: "rule", confidence: 1, amountMilli: 600_000n, priorReviewedForPayee: 0, ruleAutoApprove: true }).approve).toBe(false);
    expect(d({ method: "history", confidence: 0.98, amountMilli: 400_000n, priorReviewedForPayee: 0 }).approve).toBe(true); // income ≤ $500
    expect(d({ method: "transfer", confidence: 0.99, amountMilli: 3_000_000n, categoryIds: ["c-rta"], toReadyToAssign: true, priorReviewedForPayee: 0 }).reasons[0]).toMatch(/review 1 of the first 3/);
  });

  it("honours Settings thresholds", () => {
    const strict = { ...settings, ruleHistoryAutoApproveMin: 0.99 };
    expect(decideApproval({ ...base, confidence: 0.98 }, strict).approve).toBe(false);
  });
});
