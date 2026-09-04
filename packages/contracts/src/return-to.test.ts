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
});
