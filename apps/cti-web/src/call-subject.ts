/**
 * THE call-log subject rule (launch spec D, user-approved 2026-08-24):
 *   "Outbound Call | Voicemail | (619) 555-1234 / Jane Doe"
 * Mirrored byte-for-byte FROM services/cti-api/src/salesforce/call-subject.ts
 * (the source of truth — no shared package exists) — change BOTH or the two
 * write paths drift.
 */

/**
 * Disposition stamped by the sweep on a truly-abandoned call. The disposition
 * endpoint treats this as the one value a rep may still return to correct.
 *
 * Defined locally (not imported) because the client can't import across
 * packages. Source of truth: services/cti-api/src/salesforce/call-subject.ts.
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
  const dispo = args.disposition?.trim() || AUTO_DISPOSITION;
  const name = args.recordName?.trim();
  const who = name ? `${formatNanp(args.counterpartyE164)} / ${name}` : formatNanp(args.counterpartyE164);
  return `${args.inbound ? 'Inbound' : 'Outbound'} Call | ${dispo} | ${who}`;
}
