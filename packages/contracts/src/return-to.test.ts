import { describe, expect, it } from 'vitest';
import { isSafeReturnTo } from './return-to.js';

describe('isSafeReturnTo', () => {
  it('accepts a same-origin relative path with a query string', () => {
    expect(isSafeReturnTo('/team?x=1')).toBe(true);
  });
  it('rejects a protocol-relative path (host-confusion via //)', () => {
    expect(isSafeReturnTo('//evil.com')).toBe(false);
  });
  it('rejects a leading backslash (host-confusion via /\)', () => {
    expect(isSafeReturnTo('/\\evil.com')).toBe(false);
  });
  it('rejects an embedded space', () => {
    expect(isSafeReturnTo('/a b')).toBe(false);
  });
  it('rejects an embedded backslash', () => {
    expect(isSafeReturnTo('/x\\ty')).toBe(false);
  });
  it.each([['/api/auth/logout'], ['/api'], ['/api?x=1'], ['/healthz'], ['/readyz'], ['/readyz#top'], ['/healthz/x']])(
    'rejects an API-owned path (%s): the SPA cannot render it, so it is never a valid post-sign-in destination',
    (path) => {
      expect(isSafeReturnTo(path)).toBe(false);
    },
  );
  it('still accepts app paths that merely share a prefix with an API-owned one', () => {
    expect(isSafeReturnTo('/apis')).toBe(true);
    expect(isSafeReturnTo('/api-docs')).toBe(true);
    expect(isSafeReturnTo('/healthzone')).toBe(true);
  });
});
