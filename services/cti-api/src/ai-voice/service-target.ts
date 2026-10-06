/**
 * The four kinds of AI call target, and everything that differs between them (D-2: every switch on the kind is here,
 * explicit, never a fall-through):
 *
 *   record    the record's own phone. Gate: the record branch (consent read fresh, calling hours). A real call.
 *   test      an admin's listed test number, no record. Gate: the test branch (admin + AI_VOICE_TEST_NUMBERS).
 *   practice  (plan 1D) an admin's listed test number, with a REAL record's context for the prompt. Gate: the test
 *             branch (consent is deliberately not read: the seller is not called). The row is is_test + practice, so
 *             nothing is ever written to Salesforce for it, and a transfer rings the admin who started it.
 *   practice_browser  (plan 1E) the same practice call, but it rings the admin's browser tab (`client:<identity>`, an
 *             incoming-only Voice token, browser-token.ts) instead of a test number. Gate: the browser branch (admin, the
 *             identity names this admin, a read-only ai_pool caller ID; no phone number is dialed). is_test + practice.
 */
import { toE164 } from '@cti/phone';
import type { AiGateTarget } from './gate.js';
import type { AiCallObject, AiCallRecord } from './record.js';
import type { StartInput } from './service.js';

export type StartTarget =
  | { objectType: AiCallObject; recordId: string }
  | { testTo: string }
  | { practice: { objectType: 'Lead' | 'Opportunity'; recordId: string; to: string } }
  | { practiceBrowser: { objectType: 'Lead' | 'Opportunity'; recordId: string; identity: string } };

export type TargetKind = 'record' | 'test' | 'practice' | 'practice_browser';

export function targetKind(t: StartTarget): TargetKind {
  if ('practiceBrowser' in t) return 'practice_browser';
  if ('practice' in t) return 'practice';
  return 'testTo' in t ? 'test' : 'record';
}

/** The browser leg a practice_browser call rings. */
export const clientLeg = (identity: string): string => `client:${identity}`;

/** The number typed for a test or practice call (as given), the browser leg for practice_browser; null for a record call. */
export function typedNumber(t: StartTarget): string | null {
  if ('practiceBrowser' in t) return clientLeg(t.practiceBrowser.identity);
  if ('practice' in t) return t.practice.to;
  return 'testTo' in t ? t.testTo : null;
}

/** The record a record, practice or practice_browser call is about; null for a test call. */
function recordRef(t: StartTarget): { objectType: AiCallObject; recordId: string } | null {
  if ('practiceBrowser' in t) return t.practiceBrowser;
  if ('practice' in t) return t.practice;
  return 'testTo' in t ? null : t;
}

/** The leg a call with a record rings: the record's phone, or (practice kinds) the admin's test number or browser. */
function candidateFor(t: StartTarget, record: AiCallRecord): string | null {
  switch (targetKind(t)) {
    case 'record':
      return record.phones[0] ?? null;
    case 'practice':
      // A practice call rings the admin's test number, never the record's phone.
      return toE164(typedNumber(t) ?? '');
    case 'practice_browser':
      return typedNumber(t);
    case 'test':
      throw new Error('a test call has no record');
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The record (record and practice calls) and the number the call would ring. */
export async function loadTarget(
  i: StartInput,
): Promise<{ record: AiCallRecord | null; candidate: string | null } | { fail: 'record_not_found' | 'salesforce_error' }> {
  const t = i.target;
  const ref = recordRef(t);
  if (!ref) return { record: null, candidate: toE164(typedNumber(t) ?? '') };
  try {
    const record = await i.deps.loadRecord(i.session.userId, ref.objectType, ref.recordId);
    if (!record) return { fail: 'record_not_found' };
    return { record, candidate: candidateFor(t, record) };
  } catch (e) {
    i.deps.log.warn({ userId: i.session.userId, err: errText(e) }, 'ai-voice: record load failed');
    return { fail: 'salesforce_error' };
  }
}

/** What the gate decides on: a practice call is gated as a test call (admin + a listed number); a browser leg by the browser branch. */
export function gateTarget(t: StartTarget, record: AiCallRecord | null): AiGateTarget {
  switch (targetKind(t)) {
    case 'record':
      if (!record) throw new Error('a record call needs its record');
      return { kind: 'record', record };
    case 'test':
    case 'practice':
      return { kind: 'test', toRaw: typedNumber(t) ?? '' };
    case 'practice_browser':
      if (!('practiceBrowser' in t)) throw new Error('unreachable');
      return { kind: 'browser', identity: t.practiceBrowser.identity };
  }
}

/** The ai_calls columns that say what the call was about. Both practice kinds are is_test + practice (G-2). */
export function rowTarget(t: StartTarget) {
  if ('practiceBrowser' in t) {
    return { sfObject: t.practiceBrowser.objectType, sfRecordId: t.practiceBrowser.recordId, isTest: true, practice: true };
  }
  if ('practice' in t) {
    return { sfObject: t.practice.objectType, sfRecordId: t.practice.recordId, isTest: true, practice: true };
  }
  return 'testTo' in t
    ? { sfObject: null, sfRecordId: null, isTest: true, practice: false }
    : { sfObject: t.objectType, sfRecordId: t.recordId, isTest: false, practice: false };
}

/** Who a transfer rings: the record owner's CTI user for a real call; the starter for a test or either practice call. */
export async function handoffUser(i: StartInput, record: AiCallRecord | null): Promise<string> {
  if (targetKind(i.target) !== 'record' || !record?.ownerSfUserId) return i.session.userId;
  try {
    return (await i.deps.store.handoffUserFor(i.session.orgId, record.ownerSfUserId)) ?? i.session.userId;
  } catch (e) {
    i.deps.log.warn({ err: errText(e) }, 'ai-voice: hand-off user lookup failed, using the starter');
    return i.session.userId;
  }
}
