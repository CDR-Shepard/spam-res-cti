import { describe, expect, it } from 'vitest';
import type { InternalAiCallResponse } from '@cti/contracts';
import { CALL_WINDOW, nextWindowOpening } from '@cti/firewall';
import type { TriggerOutcome } from './cti-client.js';
import {
  FINAL_REASONS,
  IN_FLIGHT_RETRY_MS,
  MAX_TRIGGER_ATTEMPTS,
  PARK_REASONS,
  PREFERRED_WINDOWS,
  RETRY_REASONS,
  SYSTEM_REASONS,
  decideTrigger,
  nextAttemptAt,
  windowCheck,
} from './pacing-rules.js';

const AI_CALL_ID = '11111111-1111-4111-8111-111111111111';
/** Chicago (IL): the CALL_WINDOW opens at 08:00 local, 13:00Z in October (CDT). */
const TO = '+13125550100';
/** Monday 2026-10-05 14:00 CDT. */
const NOW = new Date('2026-10-05T19:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

const response = (r: InternalAiCallResponse): TriggerOutcome => ({ kind: 'response', response: r });
const blocked = (reason: Extract<InternalAiCallResponse, { result: 'blocked' }>['reason']) => response({ result: 'blocked', reason, aiCallId: AI_CALL_ID });
const failed = (reason: Extract<InternalAiCallResponse, { result: 'failed' }>['reason'], aiCallId: string | null = null) =>
  response({ result: 'failed', reason, aiCallId });
const later = (ms: number, from = NOW) => new Date(from.getTime() + ms);

describe('decideTrigger', () => {
  it('1: placed', () => {
    expect(decideTrigger(response({ result: 'placed', aiCallId: AI_CALL_ID }), 1, TO, NOW)).toEqual({ kind: 'placed', aiCallId: AI_CALL_ID });
  });

  it.each(['no_consent', 'consent_field_missing', 'no_phone', 'invalid_number', 'opted_out', 'blocked', 'dnc', 'not_admin_for_test'] as const)(
    '2: blocked %s is final with the call id',
    (reason) => {
      expect(decideTrigger(blocked(reason), 1, TO, NOW)).toEqual({ kind: 'final', reason, aiCallId: AI_CALL_ID });
    },
  );

  it('2: failed record_not_found is final, with the call id when there is one', () => {
    expect(decideTrigger(failed('record_not_found'), 1, TO, NOW)).toEqual({ kind: 'final', reason: 'record_not_found', aiCallId: null });
    expect(decideTrigger(failed('record_not_found', AI_CALL_ID), 1, TO, NOW)).toEqual({ kind: 'final', reason: 'record_not_found', aiCallId: AI_CALL_ID });
  });

  it.each(['plan_rejected', 'unknown_user'] as const)('CF-12: failed %s parks the plan (final for it, never retried), even past the attempt cap', (reason) => {
    expect(decideTrigger(failed(reason), 1, TO, NOW)).toEqual({ kind: 'park', reason });
    expect(decideTrigger(failed(reason), MAX_TRIGGER_ATTEMPTS, TO, NOW)).toEqual({ kind: 'park', reason });
  });

  it('3: calling_hours retries at the next CALL_WINDOW opening with a new key', () => {
    const night = new Date('2026-10-06T03:00:00.000Z'); // 22:00 CDT
    expect(decideTrigger(blocked('calling_hours'), 1, TO, night)).toEqual({
      kind: 'retry',
      reason: 'calling_hours',
      at: new Date('2026-10-06T13:00:00.000Z'),
      keepKey: false,
      refundAttempt: false,
    });
  });

  it('3: calling_hours inside our own window (the engine disagreed) waits 15 minutes', () => {
    expect(decideTrigger(blocked('calling_hours'), 1, TO, NOW)).toMatchObject({ kind: 'retry', at: later(15 * MIN), keepKey: false });
  });

  it.each(['daily_cap', 'customer_ceiling'] as const)('4: %s retries at the window opening 12 hours on', (reason) => {
    const at = nextWindowOpening(TO, later(12 * HOUR), CALL_WINDOW);
    expect(at).toEqual(new Date('2026-10-06T13:00:00.000Z'));
    expect(decideTrigger(blocked(reason), 1, TO, NOW)).toEqual({ kind: 'retry', reason, at, keepKey: false, refundAttempt: false });
  });

  it.each(['ai_voice_unavailable', 'no_caller_id'] as const)('5: %s retries in 30 minutes', (reason) => {
    expect(decideTrigger(blocked(reason), 1, TO, NOW)).toEqual({ kind: 'retry', reason, at: later(30 * MIN), keepKey: false, refundAttempt: true });
  });

  it('6: call_in_progress retries in 10 minutes with a new key', () => {
    expect(decideTrigger(blocked('call_in_progress'), 1, TO, NOW)).toEqual({ kind: 'retry', reason: 'call_in_progress', at: later(10 * MIN), keepKey: false, refundAttempt: false });
  });

  it('7 / CF-13: in_flight keeps the SAME key and waits at least the 10-minute stale reservation', () => {
    expect(IN_FLIGHT_RETRY_MS).toBeGreaterThanOrEqual(10 * MIN);
    expect(decideTrigger(failed('in_flight'), 1, TO, NOW)).toEqual({ kind: 'retry', reason: 'in_flight', at: later(IN_FLIGHT_RETRY_MS), keepKey: true, refundAttempt: false });
  });

  it('M-2: twilio_error may have placed the call: like no answer, the next calling window at least 20 hours on, a new key, the attempt counted', () => {
    for (const attempts of [1, 4]) {
      expect(decideTrigger(failed('twilio_error'), attempts, TO, NOW)).toEqual({
        kind: 'retry', reason: 'twilio_error', at: nextAttemptAt(TO, NOW), keepKey: false, refundAttempt: false,
      });
    }
    expect(nextAttemptAt(TO, NOW).getTime() - NOW.getTime()).toBeGreaterThanOrEqual(20 * HOUR);
  });

  it.each(['salesforce_error', 'gate_error'] as const)('8: %s backs off 5 min x 2^(attempts-1), at most 2 hours, with a new key', (reason) => {
    expect(decideTrigger(failed(reason), 1, TO, NOW)).toMatchObject({ kind: 'retry', reason, at: later(5 * MIN), keepKey: false });
    expect(decideTrigger(failed(reason), 2, TO, NOW)).toMatchObject({ at: later(10 * MIN) });
    expect(decideTrigger(failed(reason), 4, TO, NOW)).toMatchObject({ at: later(40 * MIN) });
    expect(decideTrigger(failed(reason), 7, TO, NOW)).toMatchObject({ at: later(2 * HOUR) });
  });

  it('9 / CF-13: a transport failure keeps the key, with the same backoff but never sooner than the stale reservation', () => {
    const t: TriggerOutcome = { kind: 'transport', error: 'timeout' };
    expect(decideTrigger(t, 1, TO, NOW)).toEqual({ kind: 'retry', reason: 'transport', at: later(IN_FLIGHT_RETRY_MS), keepKey: true, refundAttempt: true });
    expect(decideTrigger(t, 4, TO, NOW)).toMatchObject({ at: later(40 * MIN), keepKey: true });
    expect(decideTrigger(t, 7, TO, NOW)).toMatchObject({ at: later(2 * HOUR), keepKey: true });
  });

  it('10: a retry about the person on the eighth attempt gives up', () => {
    expect(MAX_TRIGGER_ATTEMPTS).toBe(8);
    expect(decideTrigger(failed('twilio_error'), 7, TO, NOW).kind).toBe('retry');
    expect(decideTrigger(failed('twilio_error'), 8, TO, NOW)).toEqual({ kind: 'final', reason: 'gave_up', aiCallId: null });
    expect(decideTrigger(blocked('calling_hours'), 8, TO, NOW)).toEqual({ kind: 'final', reason: 'gave_up', aiCallId: AI_CALL_ID });
    expect(decideTrigger(blocked('call_in_progress'), 8, TO, NOW)).toEqual({ kind: 'final', reason: 'gave_up', aiCallId: AI_CALL_ID });
  });

  it('I-1: a failure about the system, not the person, never gives up and gives its attempt back, with its usual backoff', () => {
    expect([...SYSTEM_REASONS].sort()).toEqual(['ai_voice_unavailable', 'gate_error', 'no_caller_id', 'salesforce_error', 'transport']);
    const system: Array<[string, TriggerOutcome, Date, boolean]> = [
      ['ai_voice_unavailable', blocked('ai_voice_unavailable'), later(30 * MIN), false],
      ['no_caller_id', blocked('no_caller_id'), later(30 * MIN), false],
      ['gate_error', failed('gate_error'), later(2 * HOUR), false],
      ['salesforce_error', failed('salesforce_error'), later(2 * HOUR), false],
      ['transport', { kind: 'transport', error: 'network' }, later(2 * HOUR), true],
    ];
    for (const [reason, outcome, at, keepKey] of system) {
      for (const attempts of [MAX_TRIGGER_ATTEMPTS, MAX_TRIGGER_ATTEMPTS + 5]) {
        expect(decideTrigger(outcome, attempts, TO, NOW)).toEqual({ kind: 'retry', reason, at, keepKey, refundAttempt: true });
      }
    }
  });

  it('I-1: a failure about the person counts its attempt', () => {
    for (const outcome of [blocked('calling_hours'), blocked('call_in_progress'), failed('in_flight'), failed('twilio_error'), blocked('daily_cap')]) {
      expect(decideTrigger(outcome, 1, TO, NOW)).toMatchObject({ kind: 'retry', refundAttempt: false });
    }
  });

  it('every reason the engine can give is final, parked or retried, never two of them', () => {
    for (const r of FINAL_REASONS) {
      expect(RETRY_REASONS.has(r)).toBe(false);
      expect(PARK_REASONS.has(r)).toBe(false);
    }
    for (const r of PARK_REASONS) expect(RETRY_REASONS.has(r)).toBe(false);
  });
});

describe('windowCheck', () => {
  it('11: any at 14:00 local is ok', () => {
    expect(windowCheck(TO, NOW, 'any')).toEqual({ ok: true });
  });
  it('11: evening at 14:00 local waits for 17:00 local today', () => {
    expect(windowCheck(TO, NOW, 'evening')).toEqual({ ok: false, at: new Date('2026-10-05T22:00:00.000Z') });
  });
  it('11: morning at 13:00 local waits for 08:00 local tomorrow', () => {
    expect(windowCheck(TO, new Date('2026-10-05T18:00:00.000Z'), 'morning')).toEqual({ ok: false, at: new Date('2026-10-06T13:00:00.000Z') });
  });
  it('11: afternoon at 14:00 local is ok', () => {
    expect(windowCheck(TO, NOW, 'afternoon')).toEqual({ ok: true });
  });
  it('11: no number uses the central-US approximation of CALL_WINDOW', () => {
    expect(windowCheck(null, NOW, 'any')).toEqual({ ok: true });
    expect(windowCheck(null, new Date('2026-10-06T03:00:00.000Z'), 'any')).toEqual({ ok: false, at: new Date('2026-10-06T13:00:00.000Z') });
  });
  it('the preferred windows sit inside the calling window', () => {
    expect(PREFERRED_WINDOWS.any).toEqual(CALL_WINDOW);
    expect(PREFERRED_WINDOWS.morning).toEqual({ start: '08:00', endExclusive: '12:00' });
    expect(PREFERRED_WINDOWS.afternoon).toEqual({ start: '12:00', endExclusive: '17:00' });
    expect(PREFERRED_WINDOWS.evening).toEqual({ start: '17:00', endExclusive: '21:00' });
  });
});

describe('nextAttemptAt', () => {
  it('12: the first CALL_WINDOW opening at least 20 hours on', () => {
    expect(nextAttemptAt(TO, NOW)).toEqual(new Date('2026-10-06T15:00:00.000Z'));
    const lateNight = new Date('2026-10-06T01:30:00.000Z'); // 20:30 CDT
    expect(nextAttemptAt(TO, lateNight)).toEqual(new Date('2026-10-06T21:30:00.000Z'));
    const evening = new Date('2026-10-06T02:00:00.000Z'); // 21:00 CDT: +20h is 17:00 CDT the next day, inside
    expect(nextAttemptAt(TO, evening)).toEqual(new Date('2026-10-06T22:00:00.000Z'));
  });
  it('12: never sooner than 20 hours', () => {
    for (const h of [0, 3, 7, 11, 15, 19, 23]) {
      const at = new Date(Date.UTC(2026, 9, 7, h, 0, 0));
      expect(nextAttemptAt(TO, at).getTime() - at.getTime()).toBeGreaterThanOrEqual(20 * HOUR);
    }
  });
});
