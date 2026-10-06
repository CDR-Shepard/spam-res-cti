import { describe, expect, it } from 'vitest';
import { AiCallOutcome } from '@cti/contracts';
import { nextStepFor, TERMINAL_AI_CALL_STATUSES } from './outcomes.js';

describe('nextStepFor (decision 9)', () => {
  it.each([
    ['qualified_transferred', { kind: 'hand_off' }],
    ['qualified_callback', { kind: 'hand_off' }],
    ['appointment_set', { kind: 'hand_off' }],
    ['transfer_failed', { kind: 'hand_off' }],
    ['not_interested', { kind: 'exit', reason: 'not_interested' }],
    ['do_not_call', { kind: 'exit', reason: 'do_not_call' }],
    ['wrong_number', { kind: 'exit', reason: 'wrong_number' }],
    ['no_answer', { kind: 'retry' }],
    ['busy', { kind: 'retry' }],
    ['voicemail', { kind: 'retry' }],
    ['failed', { kind: 'retry' }],
    ['hung_up', { kind: 'complete', reason: 'ai_call_ended' }],
    ['other', { kind: 'complete', reason: 'ai_call_ended' }],
    ['blocked', { kind: 'complete', reason: 'ai_call_ended' }],
  ] as const)('%s on attempt 1 of 3', (outcome, step) => {
    expect(nextStepFor(outcome, 1, 3)).toEqual(step);
  });

  it('no outcome at all counts as unanswered', () => {
    expect(nextStepFor(null, 1, 3)).toEqual({ kind: 'retry' });
    expect(nextStepFor(null, 3, 3)).toEqual({ kind: 'complete', reason: 'ai_call_no_answer' });
  });

  it('voicemail on attempt 3 of 3 completes with ai_call_no_answer; on 2 of 3 it retries', () => {
    expect(nextStepFor('voicemail', 3, 3)).toEqual({ kind: 'complete', reason: 'ai_call_no_answer' });
    expect(nextStepFor('voicemail', 2, 3)).toEqual({ kind: 'retry' });
    expect(nextStepFor('busy', 1, 1)).toEqual({ kind: 'complete', reason: 'ai_call_no_answer' });
  });

  it('every outcome has a step, and the terminal statuses are the four final ones', () => {
    for (const o of AiCallOutcome.options) expect(nextStepFor(o, 1, 3).kind).toMatch(/^(hand_off|exit|complete|retry)$/);
    expect([...TERMINAL_AI_CALL_STATUSES]).toEqual(['transferred', 'completed', 'failed', 'blocked']);
  });
});
