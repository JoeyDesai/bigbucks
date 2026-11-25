import { describe, expect, it } from "vitest";
import { isAmountExpression, resolveAmountText } from "./amount";

describe("resolveAmountText", () => {
  const cur = 100_000n; // $100
  it.each([
    ["", 100_000n],
    ["200", 200_000n],
    ["$1,250.50", 1_250_500n],
    ["=75", 75_000n],
    ["+50", 150_000n],
    ["-25", 75_000n],
    ["*2", 200_000n],
    ["/4", 25_000n],
    ["50*2", 100_000n],
    [".5", 500n],
  ])("%s → %s", (txt, want) => expect(resolveAmountText(txt, cur)).toBe(want));
  it("returns null on garbage", () => {
    expect(resolveAmountText("abc", cur)).toBeNull();
    expect(resolveAmountText("+", cur)).toBeNull();
  });
  it("detects expressions for the preview", () => {
    expect(isAmountExpression("+50")).toBe(true);
    expect(isAmountExpression("50*2")).toBe(true);
    expect(isAmountExpression("200")).toBe(false);
  });
});

describe("re-committing the displayed result is a no-op", () => {
  it("a formatted value resolves to itself", () => {
    expect(resolveAmountText("282.93", 282_930n)).toBe(282_930n);
    expect(resolveAmountText("1,282.93", 1_282_930n)).toBe(1_282_930n);
    expect(resolveAmountText("-12.50", -12_500n)).toBe(-25_000n); // Assigned cell: leading minus subtracts
    expect(resolveAmountText("-12.50", -12_500n, { signedAbsolute: true })).toBe(-12_500n); // form field: a sign
    expect(resolveAmountText("+5", -12_500n, { signedAbsolute: true })).toBe(-7_500n);
  });
});
