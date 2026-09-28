import { describe, expect, it } from 'vitest';
import { formatClock, formatStamp, resetPending, resetStatusLine } from './reset-status';

const clock = (iso: string): string => `<${iso.slice(11, 16)}>`;

describe('resetStatusLine — requested while the request is later than the last completion', () => {
  it('never reset → no line', () => {
    expect(resetStatusLine({ ctiResetRequestedAt: null, ctiResetCompletedAt: null }, clock)).toBeNull();
  });
  it('asked, not done yet → requested at the request', () => {
    expect(resetStatusLine({ ctiResetRequestedAt: '2026-09-28T21:41:00.000Z', ctiResetCompletedAt: null }, clock)).toBe('Reset requested <21:41>');
  });
  it('done after the request → done at the completion', () => {
    expect(resetStatusLine({ ctiResetRequestedAt: '2026-09-28T21:41:00.000Z', ctiResetCompletedAt: '2026-09-28T21:43:00.000Z' }, clock)).toBe('Reset done <21:43>');
  });
  it('asked again after the last one finished → requested again', () => {
    expect(resetStatusLine({ ctiResetRequestedAt: '2026-09-28T22:00:00.000Z', ctiResetCompletedAt: '2026-09-28T21:43:00.000Z' }, clock)).toBe('Reset requested <22:00>');
  });
  it('finished at the same instant it was asked counts as done', () => {
    expect(resetStatusLine({ ctiResetRequestedAt: '2026-09-28T21:43:00.000Z', ctiResetCompletedAt: '2026-09-28T21:43:00.000Z' }, clock)).toBe('Reset done <21:43>');
  });
});

describe('resetPending — the row still waits on the rep', () => {
  it('only while the request is later than the last completion', () => {
    expect(resetPending({ ctiResetRequestedAt: null, ctiResetCompletedAt: null })).toBe(false);
    expect(resetPending({ ctiResetRequestedAt: '2026-09-28T21:41:00.000Z', ctiResetCompletedAt: null })).toBe(true);
    expect(resetPending({ ctiResetRequestedAt: '2026-09-28T21:41:00.000Z', ctiResetCompletedAt: '2026-09-28T21:43:00.000Z' })).toBe(false);
    expect(resetPending({ ctiResetRequestedAt: '2026-09-28T22:00:00.000Z', ctiResetCompletedAt: '2026-09-28T21:43:00.000Z' })).toBe(true);
  });
});

describe('formatClock', () => {
  it('reads like "2:41 PM" in the viewer\'s time zone', () => {
    expect(formatClock(new Date(2026, 8, 28, 14, 41).toISOString(), 'en-US')).toMatch(/^2:41\sPM$/);
  });
});

// Task 3 review M-b: a stamp from another day says which day.
describe('formatStamp', () => {
  const now = new Date(2026, 8, 28, 16, 0);
  it('today: just the time', () => {
    expect(formatStamp(new Date(2026, 8, 28, 14, 41).toISOString(), now, 'en-US')).toMatch(/^2:41\sPM$/);
  });
  it('another day: the date, then the time', () => {
    expect(formatStamp(new Date(2026, 8, 27, 14, 41).toISOString(), now, 'en-US')).toMatch(/^Sep 27, 2:41\sPM$/);
    expect(formatStamp(new Date(2025, 8, 28, 14, 41).toISOString(), now, 'en-US')).toMatch(/^Sep 28, 2025, 2:41\sPM$/);
  });
});
