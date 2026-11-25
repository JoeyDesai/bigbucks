/** Password lockout and rate-limit policy — pure functions so they can be unit tested. (File and table names still say "pin" from the first login design.) */
import type { PinAttempt } from "./types";

export const PASSWORD_MIN = 6;
export const PASSWORD_MAX = 200;
export const MAX_CONSECUTIVE_FAILURES = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
export const IP_WINDOW_MS = 15 * 60 * 1000;
export const IP_MAX_ATTEMPTS = 20;
/** Failures older than this never count toward a lockout. */
export const FAILURE_MEMORY_MS = 24 * 60 * 60 * 1000;

/** Simple on purpose (the owner's call): any 6–200 characters. The lockout is what stops guessing. */
export function isValidPasswordFormat(password: string): boolean {
  return password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;
}

/**
 * A user is locked when their last 5+ attempts (since the last success, within 24h) all failed
 * and the most recent failure is less than 15 minutes old. Lock lasts until that failure + 15min.
 * After the lock expires, one more failure re-locks immediately (counter only resets on success).
 * `attempts` must be newest first.
 */
export function lockoutUntil(attempts: PinAttempt[], now: Date): Date | null {
  let failures = 0;
  let latestFailure: Date | null = null;
  for (const a of attempts) {
    if (now.getTime() - a.at.getTime() > FAILURE_MEMORY_MS) break;
    if (a.success) break;
    failures++;
    latestFailure ??= a.at;
  }
  if (failures < MAX_CONSECUTIVE_FAILURES || !latestFailure) return null;
  const until = new Date(latestFailure.getTime() + LOCKOUT_MS);
  return until > now ? until : null;
}

export function remainingBeforeLockout(attempts: PinAttempt[], now: Date): number {
  let failures = 0;
  for (const a of attempts) {
    if (now.getTime() - a.at.getTime() > FAILURE_MEMORY_MS || a.success) break;
    failures++;
  }
  return Math.max(MAX_CONSECUTIVE_FAILURES - failures, 0);
}

export function isIpRateLimited(attemptsInWindow: number): boolean {
  return attemptsInWindow >= IP_MAX_ATTEMPTS;
}

export function minutesUntil(until: Date, now: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 60_000));
}
