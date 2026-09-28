import { describe, expect, it } from 'vitest';
import { formatClock, resetStatusLine } from './reset-status';

const clock = (iso: string): string => `<${iso.slice(11, 16)}>`;

describe('resetStatusLine — pending while the request is later than the last completion', () => {
  it('never reset → no line', () => {
    expect(resetStatusLine({ ctiResetRequestedAt: null, ctiResetCompletedAt: null }, clock)).toBeNull();
  });
  it('asked, not done yet → pending since the request', () => {
    expect(resetStatusLine({ ctiResetRequestedAt: '2026-09-28T21:41:00.000Z', ctiResetCompletedAt: null }, clock)).toBe('Reset pending since <21:41>');
  });
  it('done after the request → done at the completion', () => {
    expect(resetStatusLine({ ctiResetRequestedAt: '2026-09-28T21:41:00.000Z', ctiResetCompletedAt: '2026-09-28T21:43:00.000Z' }, clock)).toBe('Reset done <21:43>');
  });
  it('asked again after the last one finished → pending again', () => {
    expect(resetStatusLine({ ctiResetRequestedAt: '2026-09-28T22:00:00.000Z', ctiResetCompletedAt: '2026-09-28T21:43:00.000Z' }, clock)).toBe('Reset pending since <22:00>');
  });
  it('finished at the same instant it was asked counts as done', () => {
    expect(resetStatusLine({ ctiResetRequestedAt: '2026-09-28T21:43:00.000Z', ctiResetCompletedAt: '2026-09-28T21:43:00.000Z' }, clock)).toBe('Reset done <21:43>');
  });
});

describe('formatClock', () => {
  it('reads like "2:41 PM" in the viewer\'s time zone', () => {
    expect(formatClock(new Date(2026, 8, 28, 14, 41).toISOString(), 'en-US')).toMatch(/^2:41\sPM$/);
  });
});
