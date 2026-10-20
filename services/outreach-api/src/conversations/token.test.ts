import { describe, expect, it } from 'vitest';
import { newConversationToken } from './store.js';

describe('newConversationToken', () => {
  it('is 26 lowercase base32 characters (a-z, 2-7), so it is safe in an email local part', () => {
    for (let n = 0; n < 500; n += 1) expect(newConversationToken()).toMatch(/^[a-z2-7]{26}$/);
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => newConversationToken()));
    expect(tokens.size).toBe(500);
  });

  it('uses the whole alphabet, including the padded last digit', () => {
    const seen = new Set<string>();
    for (let n = 0; n < 500; n += 1) for (const ch of newConversationToken()) seen.add(ch);
    expect(seen.size).toBe(32);
  });
});
