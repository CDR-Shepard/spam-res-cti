/**
 * Live `EngineDeps` factory — split out of `routes/dialer.ts` so both the
 * dialer route and the follow-up rollover worker (`salesforce/followup-worker.ts`)
 * can build real engine deps without an import cycle: this module depends only
 * on `salesforce/followup-enqueue.ts` (not `followup-worker.ts`), and
 * `followup-worker.ts` depends on this module — never the reverse.
 */
import { getDb } from '@cti/db';
import { isDailyCapped, stateForAreaCode } from '@cti/firewall';
import { loadConfig } from '../config.js';
import { dialsToPerson, inFlightElsewhere } from './contact-history-live.js';
import type { EngineDeps } from './engine.js';
import { orgMidnightUtc, orgTodayIso } from './org-day.js';
import { TwilioDialerTelephony } from './twilio-telephony.js';
import { withinCallingHours, parseCallingHoursExempt } from './pick-did.js';
import { pickDidForRun } from './pick-agent-did.js';
import { enqueueFollowupRollover } from '../salesforce/followup-enqueue.js';

/** Real EngineDeps for a request. Screen-pop is wired by Plan 4. */
export function buildEngineDeps(): EngineDeps {
  const db = getDb();
  const cfg = loadConfig();
  // Owned test DIDs in the allowlist skip the calling-hours guard so a dial-flow
  // test can run outside 8:00am-8:59pm; every other number still respects it.
  const exempt = parseCallingHoursExempt(cfg.DIALER_CALLING_HOURS_EXEMPT);
  // ONE clock for this request: `todayIso` and `orgDayStart` both derive from
  // it (a reviewer found the two separate `new Date()` calls this used to be
  // could disagree across the org's midnight, e.g. one ticking over to the
  // next day a moment before the other).
  const now = new Date();
  return {
    db,
    telephony: new TwilioDialerTelephony(),
    pickDid: (args) => pickDidForRun(db, args),
    withinCallingHours: (toE164, nowUtc) => exempt.has(toE164) || withinCallingHours(toE164, nowUtc),
    nowUtc: now,
    enqueueRollover: (job, handle) => enqueueFollowupRollover(handle, job),
    onScreenPop: () => {}, // Plan 4 wires Open CTI screen-pop
    todayIso: orgTodayIso(now),
    contactHistory: (orgId, person, since) => dialsToPerson(db, orgId, person, since),
    // The handle is the engine's — the claim transaction's `tx` — not the `db`
    // above: a second pool checkout inside that transaction deadlocks the pool.
    inFlightElsewhere: (handle, orgId, person, sessionId) => inFlightElsewhere(handle, orgId, person, sessionId),
    // `stateForAreaCode` takes the 3-digit NPA: for +1XXXYYYZZZZ that is chars 2-4.
    isDailyCapped: (toE164) => isDailyCapped(stateForAreaCode(toE164.slice(2, 5))),
    orgDayStart: orgMidnightUtc(now),
  };
}
