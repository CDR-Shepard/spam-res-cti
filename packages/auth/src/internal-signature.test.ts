import { describe, expect, it } from 'vitest';
import {
  INTERNAL_MAX_SKEW_MS,
  INTERNAL_SECRET_MIN_LENGTH,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  internalRequestHeaders,
  signInternalRequest,
  verifyInternalRequest,
  type InternalRequestParts,
} from './internal-signature.js';

const SECRET = 'k'.repeat(40);
const NOW = new Date('2026-10-05T12:00:00.000Z');
const PARTS: InternalRequestParts = { method: 'POST', path: '/internal/ai-calls', body: '{"a":1}' };

const headersOf = (h: Record<string, string>) => ({
  timestamp: h[INTERNAL_TIMESTAMP_HEADER],
  signature: h[INTERNAL_SIGNATURE_HEADER],
});
const signedAt = (at: Date, parts: InternalRequestParts = PARTS, secret = SECRET) =>
  headersOf(internalRequestHeaders(secret, parts, at));

describe('internal request signing', () => {
  it('pins the header names, the skew window and the secret minimum', () => {
    expect(INTERNAL_TIMESTAMP_HEADER).toBe('x-outreach-timestamp');
    expect(INTERNAL_SIGNATURE_HEADER).toBe('x-outreach-signature');
    expect(INTERNAL_MAX_SKEW_MS).toBe(300_000);
    expect(INTERNAL_SECRET_MIN_LENGTH).toBe(32);
  });

  it('1: round trip verifies', () => {
    const h = internalRequestHeaders(SECRET, PARTS, NOW);
    expect(h[INTERNAL_TIMESTAMP_HEADER]).toBe(String(Math.floor(NOW.getTime() / 1000)));
    expect(verifyInternalRequest(SECRET, PARTS, headersOf(h), NOW)).toEqual({ ok: true });
  });

  it('accepts a lower-case method when it was signed upper-case (the method is normalised)', () => {
    expect(verifyInternalRequest(SECRET, { ...PARTS, method: 'post' }, signedAt(NOW), NOW)).toEqual({ ok: true });
  });

  it.each([
    ['the body changed by one byte', { ...PARTS, body: '{"a":2}' }],
    ['GET instead of POST', { ...PARTS, method: 'GET' }],
    ['a query string added to the path', { ...PARTS, path: '/internal/ai-calls?x=1' }],
  ])('2: %s -> mismatch', (_label, parts) => {
    expect(verifyInternalRequest(SECRET, parts, signedAt(NOW), NOW)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it.each([
    ['301 s in the past', -301_000, 'stale'],
    ['301 s in the future', 301_000, 'stale'],
    ['299 s in the past', -299_000, 'ok'],
    ['299 s in the future', 299_000, 'ok'],
  ])('3: signed %s', (_label, offset, want) => {
    const h = signedAt(new Date(NOW.getTime() + offset));
    const verdict = verifyInternalRequest(SECRET, PARTS, h, NOW);
    expect(verdict).toEqual(want === 'ok' ? { ok: true } : { ok: false, reason: 'stale' });
  });

  it.each([
    ['no timestamp', { timestamp: undefined, signature: 'v1=' + '0'.repeat(64) }],
    ['no signature', { timestamp: '1760000000', signature: undefined }],
    ['empty timestamp', { timestamp: '', signature: 'v1=' + '0'.repeat(64) }],
  ])('4: %s -> missing', (_label, headers) => {
    expect(verifyInternalRequest(SECRET, PARTS, headers, NOW)).toEqual({ ok: false, reason: 'missing' });
  });

  it.each([
    ['a signature without v1=', { signature: '0'.repeat(64) }],
    ['a non-hex signature', { signature: 'v1=' + 'z'.repeat(64) }],
    ['an upper-case hex signature', { signature: 'v1=' + 'A'.repeat(64) }],
    ['a short signature', { signature: 'v1=' + '0'.repeat(63) }],
    ['a timestamp that is not all digits', { timestamp: '1760000000.5' }],
    ['a negative timestamp', { timestamp: '-1760000000' }],
  ])('5: %s -> malformed', (_label, patch) => {
    const headers = { ...signedAt(NOW), ...patch };
    expect(verifyInternalRequest(SECRET, PARTS, headers, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('6: a request signed with another secret -> mismatch', () => {
    const h = signedAt(NOW, PARTS, 'x'.repeat(40));
    expect(verifyInternalRequest(SECRET, PARTS, h, NOW)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('7: a secret shorter than 32 characters throws in sign, headers and verify', () => {
    const short = 's'.repeat(31);
    expect(() => signInternalRequest(short, PARTS, '1760000000')).toThrow(/at least 32/);
    expect(() => internalRequestHeaders(short, PARTS, NOW)).toThrow(/at least 32/);
    expect(() => verifyInternalRequest(short, PARTS, signedAt(NOW), NOW)).toThrow(/at least 32/);
    expect(() => verifyInternalRequest('', PARTS, signedAt(NOW), NOW)).toThrow(/at least 32/);
  });

  it('8: known vector (computed once with node:crypto)', () => {
    expect(signInternalRequest('s'.repeat(32), { method: 'POST', path: '/internal/ai-calls', body: '{}' }, '1760000000')).toBe(
      'v1=0c308629f5be13adb26e4ead74a2b2bc28fc31237ab8397fd9039013bd85f96b',
    );
  });
});
