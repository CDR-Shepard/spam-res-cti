import { REASON } from './reasons.js';
import type { CheckResult } from './types.js';

/**
 * Ten dials a minute from one DID is not a rep working a list — it is an
 * autodialer fingerprint, and it is what carrier analytics score. The cap is
 * enforced atomically at dial time by the `< 10` clause inside
 * `dialer/pick-did.ts`'s `attemptIncrement` UPDATE and its twin in
 * `routes/calls.ts`; THIS is the advisory pre-call read of the same rule, so
 * the rep is told before dialing rather than getting a bare 429 after.
 *
 * Pure and exported so the boundary is testable: gate 7b had no direct
 * coverage at all (spam-defense audit §6), and a stale window silently
 * resetting the count to 0 is exactly the arithmetic that broke the sibling
 * warmup cap in prod once already.
 */
const VELOCITY_MAX_PER_MINUTE = 10;
const VELOCITY_WINDOW_MS = 60_000;

export function velocityGateCheck(
  n: { e164: string; lastMinuteWindowStart: Date | null; lastMinuteDialCount: number },
  now: Date,
): CheckResult {
  // A window older than a minute is spent: its count describes a burst that is
  // already over, so it reads as 0 rather than blocking on stale data.
  const inWindow = n.lastMinuteWindowStart != null
    && (now.getTime() - n.lastMinuteWindowStart.getTime()) < VELOCITY_WINDOW_MS;
  const count = inWindow ? n.lastMinuteDialCount : 0;
  return count >= VELOCITY_MAX_PER_MINUTE
    ? {
        name: 'velocity',
        passed: false,
        severity: 'block',
        reasonCode: REASON.VELOCITY_BURST,
        detail: `${count} calls/min from ${n.e164} — autodialer fingerprint`,
      }
    : {
        name: 'velocity',
        passed: true,
        severity: 'info',
        reasonCode: REASON.VELOCITY_OK,
        detail: `${count}/${VELOCITY_MAX_PER_MINUTE} per min`,
      };
}
