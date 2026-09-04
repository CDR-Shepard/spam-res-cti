import { describe, expect, it } from 'vitest';
import {
  answerRateBreach,
  engagementBreach,
  shouldAutoPause,
  THRESHOLDS,
  type DidWindowStats,
} from './signals.js';

const stats = (over: Partial<DidWindowStats>): DidWindowStats => ({
  dials: 0,
  connected: 0,
  avgConnectedDuration: null,
  ...over,
});

describe('answerRateBreach', () => {
  it('does not breach below the minimum sample, even at 0% answered', () => {
    const r = answerRateBreach(stats({ dials: THRESHOLDS.ANSWER_RATE_MIN_SAMPLE - 1, connected: 0 }));
    expect(r.breach).toBe(false);
    expect(r.insufficientSample).toBe(true);
  });

  it('breaches when answer rate is below the floor over the min sample', () => {
    // 1/30 = 3.3% < 5%
    const r = answerRateBreach(stats({ dials: 30, connected: 1 }));
    expect(r.breach).toBe(true);
  });

  it('does not breach at or above the floor', () => {
    // 5/50 = 10% answered
    const r = answerRateBreach(stats({ dials: 50, connected: 5 }));
    expect(r.breach).toBe(false);
    expect(r.insufficientSample).toBe(false);
  });

  it('treats exactly at the floor as not a breach (strict <)', () => {
    // 5% exactly over 20 dials → 1 connected
    const r = answerRateBreach(stats({ dials: 20, connected: 1 }));
    expect(r.breach).toBe(false);
  });
});

describe('engagementBreach', () => {
  it('does not breach below the minimum connected sample', () => {
    const r = engagementBreach(stats({ connected: THRESHOLDS.ENGAGEMENT_MIN_SAMPLE - 1, avgConnectedDuration: 2 }));
    expect(r.breach).toBe(false);
    expect(r.insufficientSample).toBe(true);
  });

  it('breaches on sub-6s average over the min sample', () => {
    const r = engagementBreach(stats({ connected: 12, avgConnectedDuration: 4.5 }));
    expect(r.breach).toBe(true);
  });

  it('does not breach at 6s or above', () => {
    expect(engagementBreach(stats({ connected: 12, avgConnectedDuration: 6 })).breach).toBe(false);
    expect(engagementBreach(stats({ connected: 12, avgConnectedDuration: 30 })).breach).toBe(false);
  });

  it('treats null avg (no connected calls) as insufficient, never a breach', () => {
    const r = engagementBreach(stats({ connected: 20, avgConnectedDuration: null }));
    expect(r.breach).toBe(false);
    expect(r.insufficientSample).toBe(true);
  });
});

describe('shouldAutoPause', () => {
  it('pauses when either signal is breached', () => {
    expect(shouldAutoPause(stats({ dials: 40, connected: 1 })).pause).toBe(true); // answer rate
    expect(shouldAutoPause(stats({ dials: 40, connected: 40, avgConnectedDuration: 3 })).pause).toBe(true); // engagement
  });

  it('does not pause a healthy DID', () => {
    const r = shouldAutoPause(stats({ dials: 40, connected: 12, avgConnectedDuration: 45 }));
    expect(r.pause).toBe(false);
    expect(r.reasons).toHaveLength(0);
  });

  it('does not pause on a small sample (avoids punishing fresh DIDs)', () => {
    expect(shouldAutoPause(stats({ dials: 5, connected: 0 })).pause).toBe(false);
  });
});
