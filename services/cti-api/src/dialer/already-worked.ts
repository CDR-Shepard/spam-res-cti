/**
 * The cross-shift dedupe read (launch spec C): which of these numbers has the
 * TEAM power-dialed since LA midnight? Reads the append-only
 * dialer_dial_attempts log (written only by the engine's originate — manual
 * click-to-dial never lands here), so a second shift starting the same list
 * inherits the day's work. Keyed by number: the same person reached through a
 * different record is still caught.
 */
import { and, eq, gte, inArray } from 'drizzle-orm';
import type { getDb } from '../db/index.js';
import { schema } from '../db/index.js';
import { orgMidnightUtc } from './org-day.js';

type Db = ReturnType<typeof getDb>;

export async function workedTodayNumbers(
  db: Db, orgId: string, numbers: readonly string[], now: Date = new Date(),
): Promise<Set<string>> {
  if (numbers.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ toNumber: schema.dialerDialAttempts.toNumber })
    .from(schema.dialerDialAttempts)
    .where(and(
      eq(schema.dialerDialAttempts.orgId, orgId),
      inArray(schema.dialerDialAttempts.toNumber, [...numbers]),
      gte(schema.dialerDialAttempts.dialedAt, orgMidnightUtc(now)),
    ));
  return new Set(rows.map((r) => r.toNumber));
}

/** Fail OPEN (the spec's one deliberate fail-open): a broken dedupe check must
 *  never stop the team dialing — worst case is a repeat call, not a dead queue. */
export async function workedTodaySafe(
  db: Db, orgId: string, numbers: readonly string[], now: Date = new Date(),
): Promise<Set<string>> {
  try {
    return await workedTodayNumbers(db, orgId, numbers, now);
  } catch (err) {
    console.warn('[already-worked] check failed — failing OPEN (no skips):', (err as Error).message);
    return new Set();
  }
}
