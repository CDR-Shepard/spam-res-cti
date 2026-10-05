import { describe, expect, it } from 'vitest';
import { AuthProviders } from './session.js';

describe('AuthProviders', () => {
  it('round-trips the two sign-in flags', () => {
    expect(AuthProviders.parse({ salesforce: true, workos: false })).toEqual({ salesforce: true, workos: false });
  });
  it('rejects a missing or non-boolean flag', () => {
    expect(AuthProviders.safeParse({ salesforce: true }).success).toBe(false);
    expect(AuthProviders.safeParse({ salesforce: 'yes', workos: false }).success).toBe(false);
  });
});
