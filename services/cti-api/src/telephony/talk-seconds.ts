/**
 * TRUE talk time for a regular call (talk-time spec, fix 1).
 *
 * Three Twilio requests carry a duration for one click-to-dial call, and only
 * two of them measure the customer's connected line:
 *  - the `<Dial action>` (DialCallStatus present): DialCallDuration is the
 *    dialed leg from answer to hang-up — authoritative, written
 *    unconditionally; a dial that never connected is 0;
 *  - the dialed CHILD leg's own status callback (ParentCallSid present): its
 *    CallDuration — written only while nothing is there, so it never
 *    overrides the action, whichever arrives first;
 *  - the rep's own (parent) leg callback: its CallDuration spans the whole
 *    dial INCLUDING ringing. Never used here. It is what
 *    calls.duration_seconds usually ends as, and the reputation engine reads
 *    that column — which is why talk time has its own.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';

type Db = ReturnType<typeof getDb>;

export type TalkSecondsWrite =
  | { mode: 'set'; seconds: number }
  | { mode: 'if_unset'; seconds: number };

/** DialCallStatus values that mean the dialed party was connected. */
const CONNECTED_DIAL_STATUSES = new Set(['completed', 'answered']);
/** A dialed leg's final statuses when it never connected. */
const UNANSWERED_END_STATUSES = new Set(['busy', 'no-answer', 'failed', 'canceled']);

/** A Twilio duration field as whole seconds; anything else is unknown (null). */
export function parseTwilioSeconds(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** PURE: what this callback says about the call's talk time, if anything. */
export function talkSecondsWrite(body: Record<string, string | undefined>): TalkSecondsWrite | null {
  const dialStatus = body.DialCallStatus;
  if (dialStatus) {
    if (!CONNECTED_DIAL_STATUSES.has(dialStatus)) return { mode: 'set', seconds: 0 };
    const seconds = parseTwilioSeconds(body.DialCallDuration);
    return seconds === null ? null : { mode: 'set', seconds };
  }
  if (body.ParentCallSid) {
    const status = body.CallStatus ?? '';
    if (status === 'completed') {
      const seconds = parseTwilioSeconds(body.CallDuration);
      return seconds === null ? null : { mode: 'if_unset', seconds };
    }
    return UNANSWERED_END_STATUSES.has(status) ? { mode: 'if_unset', seconds: 0 } : null;
  }
  return null;
}

/** Write it: `set` always; `if_unset` only while talk_seconds is still NULL. */
export function applyTalkSeconds(db: Db, callId: string, write: TalkSecondsWrite) {
  const c = schema.calls;
  const where = write.mode === 'set' ? eq(c.id, callId) : and(eq(c.id, callId), isNull(c.talkSeconds));
  return db.update(c).set({ talkSeconds: write.seconds }).where(where);
}
