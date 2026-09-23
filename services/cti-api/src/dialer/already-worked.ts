/**
 * The queue-build dedupe read: which of these numbers has the TEAM
 * power-dialed in the last three hours — the same window `COOLDOWN_MS` gives
 * the engine's own dial-time cadence gate (`contact-history.ts`)? Reads the
 * append-only dialer_dial_attempts log (written only by the engine's
 * originate — manual click-to-dial never lands here), so a second shift
 * picking up the same list inherits the last few hours' work. Keyed by
 * number: the same person reached through a different record is still
 * caught. This is an ESTIMATE for the confirm block shown before a run
 * starts — the engine's gate at dial time is authoritative and re-checks
 * fresh, so a number that ages out of the window between queue build and
 * dial is simply dialed then, not stopped here.
 */
import { and, eq, gte, inArray } from 'drizzle-orm';
import type { getDb } from '@cti/db';
import { schema } from '@cti/db';
import { COOLDOWN_MS } from './contact-history.js';

type Db = ReturnType<typeof getDb>;

export async function workedRecentlyNumbers(
  db: Db, orgId: string, numbers: readonly string[], now: Date = new Date(),
): Promise<Set<string>> {
  if (numbers.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ toNumber: schema.dialerDialAttempts.toNumber })
    .from(schema.dialerDialAttempts)
    .where(and(
      eq(schema.dialerDialAttempts.orgId, orgId),
      inArray(schema.dialerDialAttempts.toNumber, [...numbers]),
      gte(schema.dialerDialAttempts.dialedAt, new Date(now.getTime() - COOLDOWN_MS)),
    ));
  return new Set(rows.map((r) => r.toNumber));
}

/** Fail OPEN (the spec's one deliberate fail-open): a broken dedupe check must
 *  never stop the team dialing — worst case is a repeat call, not a dead queue. */
export async function workedRecentlySafe(
  db: Db, orgId: string, numbers: readonly string[], now: Date = new Date(),
): Promise<Set<string>> {
  try {
    return await workedRecentlyNumbers(db, orgId, numbers, now);
  } catch (err) {
    console.warn('[already-worked] check failed — failing OPEN (no skips):', (err as Error).message);
    return new Set();
  }
}
