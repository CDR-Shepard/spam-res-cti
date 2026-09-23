/**
 * Daily dial cap — pre-call BLOCK for click-to-dial.
 *
 * A handful of states cap calls to the same person at DAILY_DIAL_CAP dials
 * per rolling 24h (state-calling-rules.ts's DAILY_DIAL_CAP_STATES owns the
 * list and the law citations). The power dialer already enforces its own
 * version of this cap in its own gate; this is the pre-call firewall's
 * enforcement for click-to-dial, so a rep's manual dial can't slip past it.
 *
 * Every dial by anyone counts toward the cap: power-dial attempts
 * (dialer_dial_attempts) plus outbound click-to-dial calls (calls). The two
 * sources are disjoint — the power dialer never writes a `calls` row (see
 * attempts.ts's customerAttemptCounts, which counts the same two tables for a
 * different purpose) — so summing them here cannot double-count.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { schema } from '@cti/db';
import { REASON } from './reasons.js';
import { DAILY_CAP_WINDOW_MS, DAILY_DIAL_CAP, isDailyCapped } from './state-calling-rules.js';
import type { CheckResult, Db } from './types.js';

/** The exact rep-facing sentence — exported so evaluate.ts's fail-closed path
 *  and this module's own tests both cite the same text. */
export const DAILY_CAP_DETAIL = `This number has been called ${DAILY_DIAL_CAP} times in the last 24 hours; state law limits calls to ${DAILY_DIAL_CAP} per day.`;

/**
 * Pure predicate over an already-known count: BLOCK at/over the cap in a
 * capped state, otherwise pass. Split from `dailyDialCount` so the decision
 * logic is testable without a database, same pattern as `atCustomerCeiling`.
 */
export function dailyCapCheck(state: string | null, count: number): CheckResult {
  if (isDailyCapped(state) && count >= DAILY_DIAL_CAP) {
    return {
      name: 'daily_cap',
      passed: false,
      severity: 'block',
      reasonCode: REASON.DAILY_CAP,
      detail: DAILY_CAP_DETAIL,
    };
  }
  return { name: 'daily_cap', passed: true, severity: 'info', reasonCode: REASON.DAILY_CAP_OK };
}

/**
 * Every dial by anyone to `e164` in the last DAILY_CAP_WINDOW_MS (rolling,
 * not calendar — see state-calling-rules.ts).
 */
export async function dailyDialCount(db: Db, orgId: string, e164: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - DAILY_CAP_WINDOW_MS);
  const [dialed, called] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.dialerDialAttempts)
      .where(
        and(
          eq(schema.dialerDialAttempts.orgId, orgId),
          eq(schema.dialerDialAttempts.toNumber, e164),
          gte(schema.dialerDialAttempts.dialedAt, since),
        ),
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.calls)
      .where(
        and(
          eq(schema.calls.orgId, orgId),
          eq(schema.calls.direction, 'outbound'),
          eq(schema.calls.normalizedToNumber, e164),
          gte(schema.calls.createdAt, since),
        ),
      ),
  ]);
  return (dialed[0]?.n ?? 0) + (called[0]?.n ?? 0);
}
