import { describe, expect, it } from "vitest";
import { IP_MAX_ATTEMPTS, LOCKOUT_MS, isIpRateLimited, isValidPasswordFormat, lockoutUntil, remainingBeforeLockout } from "./pin-policy";
import type { PinAttempt } from "./types";

const now = new Date("2026-10-22T12:00:00Z");
const at = (minAgo: number, success = false): PinAttempt => ({ userId: "u", ip: "100.64.0.2", success, at: new Date(now.getTime() - minAgo * 60_000) });

describe("pin policy", () => {
  it("validates 6-digit PINs only", () => {
    expect(isValidPasswordFormat("abc123")).toBe(true);
    expect(isValidPasswordFormat("12345")).toBe(false);
    expect(isValidPasswordFormat("x".repeat(201))).toBe(false);
  });
  it("locks after 5 consecutive failures for 15 minutes from the last one", () => {
    const attempts = [at(1), at(2), at(3), at(4), at(5)];
    expect(lockoutUntil(attempts, now)?.getTime()).toBe(now.getTime() - 60_000 + LOCKOUT_MS);
    expect(remainingBeforeLockout(attempts, now)).toBe(0);
  });
  it("does not lock at 4 failures", () => {
    const attempts = [at(1), at(2), at(3), at(4)];
    expect(lockoutUntil(attempts, now)).toBeNull();
    expect(remainingBeforeLockout(attempts, now)).toBe(1);
  });
  it("a success resets the count", () => {
    expect(lockoutUntil([at(1), at(2), at(3), at(4, true), at(5), at(6)], now)).toBeNull();
  });
  it("lock expires 15 minutes after the last failure", () => {
    expect(lockoutUntil([at(16), at(17), at(18), at(19), at(20)], now)).toBeNull();
  });
  it("rate-limits an IP at the threshold", () => {
    expect(isIpRateLimited(IP_MAX_ATTEMPTS - 1)).toBe(false);
    expect(isIpRateLimited(IP_MAX_ATTEMPTS)).toBe(true);
  });
});
