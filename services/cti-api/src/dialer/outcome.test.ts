import { describe, expect, it } from 'vitest';
import { isNoConnect, type DialOutcome } from './outcome.js';

const EVERY_OUTCOME: DialOutcome[] = ['connected', 'no_answer', 'voicemail', 'fax', 'busy', 'failed', 'canceled', 'hangup'];

describe('isNoConnect', () => {
  it('is false only for connected (bridge the rep) and no_answer (try the fallback number)', () => {
    expect(EVERY_OUTCOME.filter((o) => !isNoConnect(o))).toEqual(['connected', 'no_answer']);
  });
  it('is true for every plain miss', () => {
    expect(EVERY_OUTCOME.filter(isNoConnect)).toEqual(['voicemail', 'fax', 'busy', 'failed', 'canceled', 'hangup']);
  });
});
