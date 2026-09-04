import { describe, expect, it } from 'vitest';
import { signState, STATE_TTL_SECONDS, verifyState } from './state.js';

const secret = 's'.repeat(32);
const now = Date.parse('2026-09-04T12:00:00Z');

describe('oauth state', () => {
  it('round-trips a return path and rejects tampering', () => {
    const s = signState(secret, { returnTo: '/team' }, now);
    expect(verifyState(secret, s, now)).toMatchObject({ returnTo: '/team' });
    const [enc, sig] = s.split('.') as [string, string];
    expect(verifyState(secret, `${enc}x.${sig}`, now)).toBeNull();
    expect(verifyState('other-secret-that-is-long-enough', s, now)).toBeNull();
    expect(verifyState(secret, 'garbage', now)).toBeNull();
  });
  it('expires after the TTL and rejects future-dated state', () => {
    const s = signState(secret, {}, now);
    expect(verifyState(secret, s, now + STATE_TTL_SECONDS * 1000)).not.toBeNull();
    expect(verifyState(secret, s, now + (STATE_TTL_SECONDS + 1) * 1000)).toBeNull();
    expect(verifyState(secret, s, now - 5_000)).toBeNull();
  });
  it('only accepts same-origin relative return paths', () => {
    const evil = signState(secret, { returnTo: 'https://evil.example/x' }, now);
    expect(verifyState(secret, evil, now)).toBeNull();
    const proto = signState(secret, { returnTo: '//evil.example' }, now);
    expect(verifyState(secret, proto, now)).toBeNull();
  });
});
