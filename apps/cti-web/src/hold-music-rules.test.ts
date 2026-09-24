import { describe, expect, it } from 'vitest';
import { heardSomeone, shouldPlay, type PlayContext } from './hold-music-rules';

describe('heardSomeone — two loud samples in a row, never one click', () => {
  it.each([
    [[0.3, 0.3], true],
    [[0.02, 0.02], true],
    [[0.3], false],
    [[0.3, 0.01], false],
    [[0.01, 0.3], false],
    [[], false],
    [[0.001, 0.3, 0.4], true],
  ] as const)('%j → %s', (levels, expected) => {
    expect(heardSomeone(levels)).toBe(expected);
  });
});

describe('shouldPlay', () => {
  const base: PlayContext = {
    sessionStatus: 'active',
    currentItem: { status: 'dialing', prospectEndedAt: null },
    lineQuietForMs: 5000,
  };

  it('plays while an active run is ringing the next number and the line has been quiet 1.5 s', () => {
    expect(shouldPlay(base)).toBe(true);
    expect(shouldPlay({ ...base, currentItem: null })).toBe(true);
    expect(shouldPlay({ ...base, lineQuietForMs: 1499 })).toBe(false);
    expect(shouldPlay({ ...base, lineQuietForMs: 1500 })).toBe(true);
  });

  it('never during a conversation, nor during the "They hung up" choice', () => {
    expect(shouldPlay({ ...base, currentItem: { status: 'connected', prospectEndedAt: null } })).toBe(false);
    expect(shouldPlay({ ...base, currentItem: { status: 'connected', prospectEndedAt: '2026-09-23T18:00:00Z' } })).toBe(false);
  });

  it('never unless the run is active', () => {
    for (const s of ['ready', 'paused', 'stopped', 'done'] as const) {
      expect(shouldPlay({ ...base, sessionStatus: s })).toBe(false);
    }
  });
});
