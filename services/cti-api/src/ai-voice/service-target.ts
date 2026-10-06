/**
 * The three kinds of AI call target, and everything that differs between them (D-2: every switch on the kind is here,
 * explicit, never a fall-through):
 *
 *   record    the record's own phone. Gate: the record branch (consent read fresh, calling hours). A real call.
 *   test      an admin's listed test number, no record. Gate: the test branch (admin + AI_VOICE_TEST_NUMBERS).
 *   practice  (plan 1D) an admin's listed test number, with a REAL record's context for the prompt. Gate: the test
 *             branch (consent is deliberately not read: the seller is not called). The row is is_test + practice, so
 *             nothing is ever written to Salesforce for it, and a transfer rings the admin who started it.
 */
import { toE164 } from '@cti/phone';
import type { AiGateTarget } from './gate.js';
import type { AiCallObject, AiCallRecord } from './record.js';
import type { StartInput } from './service.js';

export type StartTarget =
  | { objectType: AiCallObject; recordId: string }
  | { testTo: string }
  | { practice: { objectType: 'Lead' | 'Opportunity'; recordId: string; to: string } };

export type TargetKind = 'record' | 'test' | 'practice';

export function targetKind(t: StartTarget): TargetKind {
  if ('practice' in t) return 'practice';
  return 'testTo' in t ? 'test' : 'record';
}

/** The number typed for a test or practice call (as given); null for a record call (the record has the phone). */
export function typedNumber(t: StartTarget): string | null {
  if ('practice' in t) return t.practice.to;
  return 'testTo' in t ? t.testTo : null;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The record (record and practice calls) and the number the call would ring. */
export async function loadTarget(
  i: StartInput,
): Promise<{ record: AiCallRecord | null; candidate: string | null } | { fail: 'record_not_found' | 'salesforce_error' }> {
  const t = i.target;
  if ('testTo' in t) return { record: null, candidate: toE164(t.testTo) };
  const { objectType, recordId } = 'practice' in t ? t.practice : t;
  try {
    const record = await i.deps.loadRecord(i.session.userId, objectType, recordId);
    if (!record) return { fail: 'record_not_found' };
    // A practice call rings the admin's test number, never the record's phone.
    return { record, candidate: 'practice' in t ? toE164(t.practice.to) : (record.phones[0] ?? null) };
  } catch (e) {
    i.deps.log.warn({ userId: i.session.userId, err: errText(e) }, 'ai-voice: record load failed');
    return { fail: 'salesforce_error' };
  }
}

/** What the gate decides on: a practice call is gated as a test call (admin + a listed number). */
export function gateTarget(t: StartTarget, record: AiCallRecord | null): AiGateTarget {
  switch (targetKind(t)) {
    case 'record':
      if (!record) throw new Error('a record call needs its record');
      return { kind: 'record', record };
    case 'test':
    case 'practice':
      return { kind: 'test', toRaw: typedNumber(t) ?? '' };
  }
}

/** The ai_calls columns that say what the call was about. */
export function rowTarget(t: StartTarget) {
  if ('practice' in t) {
    return { sfObject: t.practice.objectType, sfRecordId: t.practice.recordId, isTest: true, practice: true };
  }
  return 'testTo' in t
    ? { sfObject: null, sfRecordId: null, isTest: true, practice: false }
    : { sfObject: t.objectType, sfRecordId: t.recordId, isTest: false, practice: false };
}

/** Who a transfer rings: the record owner's CTI user for a real call; the starter for a test or practice call. */
export async function handoffUser(i: StartInput, record: AiCallRecord | null): Promise<string> {
  if (targetKind(i.target) !== 'record' || !record?.ownerSfUserId) return i.session.userId;
  try {
    return (await i.deps.store.handoffUserFor(i.session.orgId, record.ownerSfUserId)) ?? i.session.userId;
  } catch (e) {
    i.deps.log.warn({ err: errText(e) }, 'ai-voice: hand-off user lookup failed, using the starter');
    return i.session.userId;
  }
}
