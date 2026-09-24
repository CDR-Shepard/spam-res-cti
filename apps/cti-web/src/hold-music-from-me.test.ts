import { describe, expect, it } from 'vitest';
import type { HoldMusicSetting } from '@cti/contracts';
import { holdMusicFromMe } from './hold-music-from-me';

describe('holdMusicFromMe', () => {
  it('returns the server holdMusic object as is when present, ignoring the legacy flag', () => {
    const holdMusic: HoldMusicSetting = { choice: 'rock', youtube: null };
    expect(holdMusicFromMe({ holdMusic, dialerHoldMusic: true })).toBe(holdMusic);
  });

  it('absent + legacy dialerHoldMusic: false -> off', () => {
    expect(holdMusicFromMe({ dialerHoldMusic: false })).toEqual({ choice: 'off', youtube: null });
  });

  it('absent + legacy dialerHoldMusic: true -> classical', () => {
    expect(holdMusicFromMe({ dialerHoldMusic: true })).toEqual({ choice: 'classical', youtube: null });
  });

  it('absent + legacy dialerHoldMusic undefined -> classical', () => {
    expect(holdMusicFromMe({})).toEqual({ choice: 'classical', youtube: null });
  });
});
