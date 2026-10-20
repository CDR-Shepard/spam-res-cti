import { describe, expect, it } from 'vitest';
import { AiCallOutcome } from '@cti/contracts';
import { OUTCOME_WORDS } from './context.js';
import { WRITEBACK_OUTCOMES } from './store.js';

describe('the write-back outcome words', () => {
  it('has words for every call outcome (the Event, Tasks, Chatter and the dry-run read them)', () => {
    for (const outcome of AiCallOutcome.options) expect(OUTCOME_WORDS[outcome]?.length).toBeGreaterThan(0);
  });

  it("words an already-booked call 'Already booked'", () => {
    expect(OUTCOME_WORDS.already_booked).toBe('Already booked');
  });

  it('does not write already_booked back: the seller already has a consultation, so there is nothing to change', () => {
    expect([...WRITEBACK_OUTCOMES]).not.toContain('already_booked');
  });
});
