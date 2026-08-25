import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MobilePairingCard, pairCodeCountdown, pairCodeExpired } from './MobilePairingCard';

describe('pairCodeCountdown', () => {
  it('counts down "m:ss" to the expiry', () => {
    const now = Date.parse('2026-08-25T12:00:00Z');
    expect(pairCodeCountdown(new Date(now + 5 * 60_000).toISOString(), now)).toBe('5:00');
    expect(pairCodeCountdown(new Date(now + 65_000).toISOString(), now)).toBe('1:05');
    expect(pairCodeCountdown(new Date(now + 9_000).toISOString(), now)).toBe('0:09');
  });

  it('clamps at 0:00 rather than going negative once the code has expired', () => {
    const now = Date.parse('2026-08-25T12:00:00Z');
    expect(pairCodeCountdown(new Date(now - 30_000).toISOString(), now)).toBe('0:00');
  });
});

describe('pairCodeExpired', () => {
  const now = Date.parse('2026-08-25T12:00:00Z');
  it('is false while time remains', () => {
    expect(pairCodeExpired(new Date(now + 1000).toISOString(), now)).toBe(false);
  });
  it('is true once the expiry has passed (or lands exactly on it)', () => {
    expect(pairCodeExpired(new Date(now - 1).toISOString(), now)).toBe(true);
    expect(pairCodeExpired(new Date(now).toISOString(), now)).toBe(true);
  });
});

describe('MobilePairingCard (initial render)', () => {
  // SSR never runs the effects (no device list fetch), so the initial markup
  // is exactly the "no code yet, no devices loaded yet" state.
  it('offers to get a pairing code', () => {
    const html = renderToStaticMarkup(<MobilePairingCard onToast={() => {}} />);
    expect(html).toContain('Pair your iPhone');
    expect(html).toContain('Get pairing code');
  });
});
