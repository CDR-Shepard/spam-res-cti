import { describe, expect, it } from 'vitest';
import {
  AiAvailability,
  AiCallBlockReason,
  AiCallFailReason,
  AiCallResult,
  INTERNAL_AI_AVAILABILITY_PATH,
  INTERNAL_AI_CALLS_PATH,
  IdempotencyKey,
  InternalAiCallRequest,
  InternalAiCallResponse,
  PLAN_TEXT_MAX,
  TestCallRequest,
} from './ai-calls.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CALL = '33333333-3333-4333-8333-333333333333';
const TOUCH = '44444444-4444-4444-8444-444444444444';

const recordRequest = {
  orgId: ORG,
  userId: USER,
  idempotencyKey: `touch:${TOUCH}:1`,
  target: { kind: 'record', objectType: 'Lead', recordId: '00Q000000000001AAA', planText: 'x' },
};
const withTarget = (patch: Record<string, unknown>) => ({ ...recordRequest, target: { ...recordRequest.target, ...patch } });

/** The cti-api gate's AiGateBlock union plus service.ts's call_in_progress, pinned (cti-api compares too). */
const PINNED_BLOCK_REASONS = [
  'ai_voice_unavailable', 'no_consent', 'consent_field_missing', 'no_phone', 'opted_out', 'blocked', 'dnc',
  'daily_cap', 'customer_ceiling', 'calling_hours', 'no_caller_id', 'not_admin_for_test', 'invalid_number', 'call_in_progress',
] as const;

describe('internal AI call contracts', () => {
  it('pins the paths and the plan text cap', () => {
    expect(INTERNAL_AI_CALLS_PATH).toBe('/internal/ai-calls');
    expect(INTERNAL_AI_AVAILABILITY_PATH).toBe('/internal/ai-calls/availability');
    expect(PLAN_TEXT_MAX).toBe(4000);
  });

  it('1: accepts a record request', () => {
    expect(InternalAiCallRequest.parse(recordRequest)).toEqual(recordRequest);
  });

  it.each([
    ['objectType Contact', withTarget({ objectType: 'Contact' })],
    ['a 4,001-character planText', withTarget({ planText: 'x'.repeat(4001) })],
    ['an empty planText on a record target', withTarget({ planText: '' })],
    ['a null planText on a record target', withTarget({ planText: null })],
    ["a recordId with a quote", withTarget({ recordId: "00Q00000000000'AAA" })],
    ['an unknown key on the target', withTarget({ extra: 1 })],
    ['an unknown top-level key', { ...recordRequest, extra: true }],
    ['an idempotency key with a space', { ...recordRequest, idempotencyKey: 'touch: 1:1' }],
    ['a short idempotency key', { ...recordRequest, idempotencyKey: 'touch:1' }],
    ['a non-uuid orgId', { ...recordRequest, orgId: 'org-1' }],
  ])('2: rejects %s', (_label, body) => {
    expect(InternalAiCallRequest.safeParse(body).success).toBe(false);
  });

  it('accepts exactly PLAN_TEXT_MAX characters', () => {
    expect(InternalAiCallRequest.safeParse(withTarget({ planText: 'x'.repeat(PLAN_TEXT_MAX) })).success).toBe(true);
  });

  it('3: accepts a test target with no plan', () => {
    const body = { ...recordRequest, target: { kind: 'test', to: '+15125550100', planText: null } };
    expect(InternalAiCallRequest.parse(body)).toEqual(body);
  });

  it('idempotency keys are letters, digits and : _ -', () => {
    expect(IdempotencyKey.safeParse(`touch:${TOUCH}:12`).success).toBe(true);
    expect(IdempotencyKey.safeParse('test:abc_def-1').success).toBe(true);
    expect(IdempotencyKey.safeParse('touch/1/2/3').success).toBe(false);
  });

  it('4: the response union', () => {
    expect(InternalAiCallResponse.parse({ result: 'placed', aiCallId: CALL })).toEqual({ result: 'placed', aiCallId: CALL });
    expect(InternalAiCallResponse.parse({ result: 'blocked', reason: 'no_consent', aiCallId: CALL }).result).toBe('blocked');
    expect(InternalAiCallResponse.parse({ result: 'failed', reason: 'in_flight', aiCallId: null }).result).toBe('failed');
    expect(InternalAiCallResponse.safeParse({ result: 'blocked', reason: 'twilio_error', aiCallId: CALL }).success).toBe(false);
    expect(InternalAiCallResponse.safeParse({ result: 'blocked', reason: 'no_consent', aiCallId: null }).success).toBe(false);
  });

  it('a rejected plan is a failure without a call (CF-9)', () => {
    expect(AiCallFailReason.options).toContain('plan_rejected');
    expect(InternalAiCallResponse.parse({ result: 'failed', reason: 'plan_rejected', aiCallId: null }).result).toBe('failed');
  });

  it('5: block reasons are the gate codes plus call_in_progress', () => {
    expect([...AiCallBlockReason.options]).toEqual([...PINNED_BLOCK_REASONS]);
  });

  it('fail reasons never overlap block reasons', () => {
    const blocks = new Set<string>(AiCallBlockReason.options);
    expect(AiCallFailReason.options.filter((r) => blocks.has(r))).toEqual([]);
  });

  it('availability and test call bodies', () => {
    expect(AiAvailability.parse({ available: true, testNumbers: ['+15125550100'] }).available).toBe(true);
    expect(TestCallRequest.safeParse({ to: '+15125550100' }).success).toBe(true);
    expect(TestCallRequest.safeParse({ to: '123' }).success).toBe(false);
  });

  it('an AI call result row', () => {
    const row = {
      touchId: TOUCH, enrollmentId: TOUCH, name: 'Pat', sfObject: 'Lead', sfRecordId: '00Q000000000001AAA', recordUrl: null,
      touchStatus: 'sent', dueAt: '2026-10-05T12:00:00.000Z', attempts: 1, lastBlockReason: null, aiCallId: CALL,
      callStatus: 'completed', outcome: 'not_interested', summary: null, qualification: null, durationSeconds: 42,
      startedAt: null, enrollmentStatus: 'exited', exitReason: 'not_interested', mayReadTranscript: true,
    };
    expect(AiCallResult.parse(row)).toEqual(row);
  });
});
