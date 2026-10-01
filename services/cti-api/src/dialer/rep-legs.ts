/**
 * Time on the power dialer (talk-time spec): one dialer_rep_legs row per rep
 * conference leg, from the join to the leg's end — dialing, hold music and
 * talking all count.
 *
 * Opened by the voice route right after it stamps the leg on its run. Ended by
 * whichever hears it first: the leg's own status callback (status route), the
 * rejoin route (the rep hung up, or the server answers Hangup), the engine's
 * run end (`releaseRepConference`), or a newer leg replacing it on the same run.
 * A leg whose every end was missed is closed by dialer/rep-leg-reconcile.ts.
 *
 * Everything here is best-effort and NEVER throws: a failed stamp must never
 * keep a rep out of their room, delay a rejoin answer, or fail a run's end.
 */
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { getDb, schema, type DialerRepLegEndSource } from '@cti/db';
import { TWILIO_CALL_SID_RE } from '../telephony/webhooks.js';

type Db = ReturnType<typeof getDb>;

/** PURE: open a leg for the run whose rep_call_sid it was just stamped as —
 *  one statement, so the row carries the run's org and id without another
 *  read. Bare ON CONFLICT DO NOTHING (the call_sid index is FULL): a repeated
 *  join request writes nothing. */
export function repLegJoinStatement(userId: string, callSid: string, joinedAt: Date): SQL {
  return sql`
    insert into dialer_rep_legs (org_id, user_id, session_id, call_sid, joined_at)
    select org_id, user_id, id, rep_call_sid, ${joinedAt.toISOString()}::timestamptz from dialer_sessions
    where user_id = ${userId} and rep_call_sid = ${callSid} limit 1
    on conflict do nothing`;
}

export async function recordRepLegJoined(db: Db, userId: string, callSid: string, joinedAt: Date): Promise<void> {
  try {
    await db.execute(repLegJoinStatement(userId, callSid, joinedAt));
  } catch (err) {
    console.error('[dialer] rep leg join not recorded', { userId, err: (err as Error).message });
  }
}

/** Close an open leg, once: a leg that already ended keeps its first end. */
export function repLegEndStatement(db: Db, callSid: string, endedAt: Date, source: DialerRepLegEndSource) {
  const l = schema.dialerRepLegs;
  return db
    .update(l)
    .set({ endedAt, endSource: source, updatedAt: new Date() })
    .where(and(eq(l.callSid, callSid), isNull(l.endedAt)));
}

export async function recordRepLegEnded(
  db: Db,
  callSid: string | undefined,
  endedAt: Date,
  source: DialerRepLegEndSource,
): Promise<void> {
  if (!callSid || !TWILIO_CALL_SID_RE.test(callSid)) return;
  try {
    await repLegEndStatement(db, callSid, endedAt, source);
  } catch (err) {
    console.error('[dialer] rep leg end not recorded', { source, err: (err as Error).message });
  }
}
