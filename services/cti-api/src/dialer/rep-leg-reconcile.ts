/**
 * Close rep legs whose end we never heard (talk-time spec). The leg's status
 * callback, the rejoin route, the run end and a replacing leg each stamp an
 * end; a lost callback leaves a leg open, and the report counts an open leg up
 * to "now". Every few minutes, ask Twilio about each open leg.
 *
 * At most RECONCILE_BATCH legs a tick, oldest first: a handful of reps are on
 * the dialer at once, so the batch always reaches today's legs.
 */
import { asc, isNull } from 'drizzle-orm';
import { getDb, schema, type DialerRepLeg } from '@cti/db';
import { repLegEndStatement } from './rep-legs.js';
import { TwilioDialerTelephony, type CallEnd } from './twilio-telephony.js';

type Db = ReturnType<typeof getDb>;

export const RECONCILE_INTERVAL_MS = 5 * 60_000;
export const RECONCILE_BATCH = 25;
/** A leg Twilio cannot answer for this long is closed by rule… */
export const GIVE_UP_AFTER_MS = 48 * 3_600_000;
/** …at this length (a long shift): the report never shows an endless leg. */
export const FALLBACK_LEG_MS = 12 * 3_600_000;

export interface ReconcileDeps {
  db: Db;
  now: () => Date;
  callEnd: (callSid: string) => Promise<CallEnd>;
}

type OpenLeg = Pick<DialerRepLeg, 'id' | 'callSid' | 'joinedAt'>;

export function selectOpenLegs(db: Db) {
  const l = schema.dialerRepLegs;
  return db
    .select({ id: l.id, callSid: l.callSid, joinedAt: l.joinedAt })
    .from(l)
    .where(isNull(l.endedAt))
    .orderBy(asc(l.joinedAt))
    .limit(RECONCILE_BATCH);
}

/** One open leg. A failed DB write propagates (the tick logs it); only the
 *  Twilio question has a fallback. */
export async function reconcileLeg(leg: OpenLeg, deps: ReconcileDeps): Promise<'open' | 'reconciled' | 'fallback' | 'retry'> {
  let end: CallEnd;
  try {
    end = await deps.callEnd(leg.callSid);
  } catch (err) {
    if (deps.now().getTime() - leg.joinedAt.getTime() < GIVE_UP_AFTER_MS) {
      console.warn('[dialer] rep leg reconcile failed; retrying next tick', { legId: leg.id, err: (err as Error).message });
      return 'retry';
    }
    await repLegEndStatement(deps.db, leg.callSid, new Date(leg.joinedAt.getTime() + FALLBACK_LEG_MS), 'fallback');
    console.error('[dialer] rep leg closed by rule — Twilio could not give its end', { legId: leg.id });
    return 'fallback';
  }
  if (!end.ended) return 'open';
  await repLegEndStatement(deps.db, leg.callSid, end.endedAt ?? leg.joinedAt, 'reconciled');
  return 'reconciled';
}

export async function reconcileRepLegsTick(deps: ReconcileDeps): Promise<void> {
  for (const leg of await selectOpenLegs(deps.db)) {
    try {
      await reconcileLeg(leg, deps);
    } catch (err) {
      console.error('[dialer] rep leg reconcile write failed', { legId: leg.id, err: (err as Error).message });
    }
  }
}

function liveReconcileDeps(): ReconcileDeps {
  const telephony = new TwilioDialerTelephony();
  return { db: getDb(), now: () => new Date(), callEnd: (callSid) => telephony.callEnd(callSid) };
}

/** Single-flight: a slow tick is never overlapped. `deps` is a test seam. */
export function startRepLegReconcileLoop(
  intervalMs: number = RECONCILE_INTERVAL_MS,
  deps: () => ReconcileDeps = liveReconcileDeps,
): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    reconcileRepLegsTick(deps())
      .catch((err) => console.error('[dialer] rep leg reconcile tick failed', { err: (err as Error).message }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
}
