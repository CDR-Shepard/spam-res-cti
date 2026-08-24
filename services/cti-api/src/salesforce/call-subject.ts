/**
 * THE call-log subject rule (launch spec D, user-approved 2026-08-24):
 *   "Outbound Call | Voicemail | (619) 555-1234 / Jane Doe"
 * Mirrored byte-for-byte in apps/cti-web/src/call-subject.ts (no shared package
 * exists) — change BOTH or the two write paths drift.
 */
import { AUTO_DISPOSITION } from './sync.js';

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
