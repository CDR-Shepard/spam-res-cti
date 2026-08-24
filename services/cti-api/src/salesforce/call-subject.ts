/**
 * THE call-log subject rule (launch spec D, user-approved 2026-08-24):
 *   "Outbound Call | Voicemail | (619) 555-1234 / Jane Doe"
 * Mirrored byte-for-byte in apps/cti-web/src/call-subject.ts (no shared package
 * exists) — change BOTH or the two write paths drift.
 */

/**
 * Disposition stamped by the sweep on a truly-abandoned call. The disposition
 * endpoint treats this as the one value a rep may still return to correct.
 *
 * Lives here (not sync.ts, where the sweep that stamps it runs) because
 * buildCallSubject needs it too and sync.ts imports buildCallSubject from
 * this module — importing back from sync.ts would be a cycle. sync.ts
 * re-exports this so its existing consumers (routes/calls.ts) are unaffected.
 */
export const AUTO_DISPOSITION = 'Not dispositioned';

/** NANP e164 → "(XXX) XXX-XXXX"; anything else passes through untouched. */
export function formatNanp(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function buildCallSubject(args: {
  inbound: boolean;
  disposition: string | null | undefined;
  counterpartyE164: string;
  recordName?: string | null;
}): string {
  // An INBOUND call never gets a disposition anywhere in the system (there is
  // no wrap-up form, and the abandoned-call sweep is outbound-scoped), so the
  // auto-disposition fallback would fire on 100% of them and every inbound
  // Task would read as a system-wide failure to disposition. Inbound with no
  // disposition therefore drops the middle slot entirely; an inbound call that
  // somehow DOES carry one still shows it, and OUTBOUND keeps the fallback
  // (where "Not dispositioned" is the true, actionable state).
  const dispo = args.disposition?.trim() || (args.inbound ? null : AUTO_DISPOSITION);
  const name = args.recordName?.trim();
  const who = name ? `${formatNanp(args.counterpartyE164)} / ${name}` : formatNanp(args.counterpartyE164);
  const head = `${args.inbound ? 'Inbound' : 'Outbound'} Call`;
  return dispo ? `${head} | ${dispo} | ${who}` : `${head} | ${who}`;
}
