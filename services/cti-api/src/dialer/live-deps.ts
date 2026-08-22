/**
 * Live `EngineDeps` factory — split out of `routes/dialer.ts` so both the
 * dialer route and the follow-up rollover worker (`salesforce/followup-worker.ts`)
 * can build real engine deps without an import cycle: this module depends only
 * on `salesforce/followup-enqueue.ts` (not `followup-worker.ts`), and
 * `followup-worker.ts` depends on this module — never the reverse.
 */
import { getDb } from '../db/index.js';
import { loadConfig } from '../config.js';
import type { EngineDeps } from './engine.js';
import { TwilioDialerTelephony } from './twilio-telephony.js';
import { pickPoolDid, withinCallingHours, parseCallingHoursExempt } from './pick-did.js';
import { enqueueFollowupRollover } from '../salesforce/followup-enqueue.js';

/** GG Homes operates out of America/Los_Angeles — the rollover follow-up's
 *  "today" is computed in that org timezone, not the server's (UTC on Railway). */
const ORG_TIMEZONE = 'America/Los_Angeles';

/** `YYYY-MM-DD` for `now` in the org's timezone. `en-CA` formats as ISO order,
 *  so no further reassembly is needed. */
export function orgTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ORG_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Real EngineDeps for a request. Screen-pop is wired by Plan 4. */
export function buildEngineDeps(): EngineDeps {
  const db = getDb();
  const cfg = loadConfig();
  // Owned test DIDs in the allowlist skip the calling-hours guard so a dial-flow
  // test can run outside 8am-9pm; every other number still respects it.
  const exempt = parseCallingHoursExempt(cfg.DIALER_CALLING_HOURS_EXEMPT);
  return {
    db,
    telephony: new TwilioDialerTelephony(),
    pickDid: (orgId, userId, toE164) => pickPoolDid(db, { orgId, userId, toE164 }),
    withinCallingHours: (toE164, nowUtc) => exempt.has(toE164) || withinCallingHours(toE164, nowUtc),
    nowUtc: new Date(),
    enqueueRollover: (job, handle) => enqueueFollowupRollover(handle, job),
    onScreenPop: () => {}, // Plan 4 wires Open CTI screen-pop
    todayIso: orgTodayIso(),
  };
}
