import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isSafeReturnTo, signState, STATE_TTL_SECONDS, verifyState } from './state.js';

const secret = 's'.repeat(32);
const now = Date.parse('2026-09-04T12:00:00Z');

describe('oauth state', () => {
  it('round-trips a return path and rejects tampering', () => {
    const { state: s } = signState(secret, { returnTo: '/team' }, now);
    expect(verifyState(secret, s, now)).toMatchObject({ returnTo: '/team' });
    const [enc, sig] = s.split('.') as [string, string];
    expect(verifyState(secret, `${enc}x.${sig}`, now)).toBeNull();
    expect(verifyState('other-secret-that-is-long-enough', s, now)).toBeNull();
    expect(verifyState(secret, 'garbage', now)).toBeNull();
    // A well-formed, correctly signed token with a trailing extra segment must not
    // be accepted by silently discarding the third part.
    expect(verifyState(secret, `${s}.junk`, now)).toBeNull();
    // A validly signed payload that decodes to the JSON literal `null` (not an
    // object) must not crash `verifyState` reading `.nonce` off it, and must be
    // rejected. Signed by hand here with the same HMAC recipe as `state.ts`.
    const encNull = Buffer.from(JSON.stringify(null), 'utf8').toString('base64url');
    const sigForNull = createHmac('sha256', secret).update(encNull).digest('base64url');
    expect(verifyState(secret, `${encNull}.${sigForNull}`, now)).toBeNull();
  });
  it('expires after the TTL and rejects future-dated state', () => {
    const { state: s } = signState(secret, {}, now);
    expect(verifyState(secret, s, now + STATE_TTL_SECONDS * 1000)).not.toBeNull();
    expect(verifyState(secret, s, now + (STATE_TTL_SECONDS + 1) * 1000)).toBeNull();
    expect(verifyState(secret, s, now - 5_000)).toBeNull();
  });
  it('only accepts same-origin relative return paths', () => {
    const { state: evil } = signState(secret, { returnTo: 'https://evil.example/x' }, now);
    expect(verifyState(secret, evil, now)).toBeNull();
    const { state: proto } = signState(secret, { returnTo: '//evil.example' }, now);
    expect(verifyState(secret, proto, now)).toBeNull();
  });
  it('exposes the nonce it embeds in the signed state, fresh on every call', () => {
    const a = signState(secret, {}, now);
    const b = signState(secret, {}, now);
    expect(a.nonce).toBeTruthy();
    expect(a.nonce).not.toBe(b.nonce);
    expect(verifyState(secret, a.state, now)).toMatchObject({ nonce: a.nonce });
  });
});

describe('isSafeReturnTo', () => {
  it('rejects a leading or embedded backslash and embedded spaces; accepts a safe path with a query', () => {
    expect(isSafeReturnTo('/\\evil.com')).toBe(false);
    expect(isSafeReturnTo('/x\\y')).toBe(false);
    expect(isSafeReturnTo('/a b')).toBe(false);
    expect(isSafeReturnTo('/team?x=1')).toBe(true);
  });
});
