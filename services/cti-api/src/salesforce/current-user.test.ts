import { describe, expect, it } from 'vitest';
import { parseChatterMeId } from './current-user.js';

describe('parseChatterMeId', () => {
  it('reads .id from a chatter users/me response', () => {
    expect(parseChatterMeId({ id: '005xx', firstName: 'A' })).toBe('005xx');
    expect(parseChatterMeId({})).toBeNull();
    expect(parseChatterMeId(null)).toBeNull();
  });
});
