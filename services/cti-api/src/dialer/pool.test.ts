import { describe, expect, it } from 'vitest';
import { isDialerPoolKind } from './pool.js';

describe('isDialerPoolKind', () => {
  it('recognizes the dialer pool kind only', () => {
    expect(isDialerPoolKind('dialer_pool')).toBe(true);
    expect(isDialerPoolKind('agent')).toBe(false);
    expect(isDialerPoolKind('')).toBe(false);
  });
});
