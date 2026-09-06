import { describe, expect, it } from 'vitest';
import { isClientError } from './workos-provider.js';

describe('isClientError', () => {
  it.each([400, 401, 404])('maps a WorkOS %d into an IdentityExchangeError (true)', (status) => {
    expect(isClientError({ status })).toBe(true);
  });
  it.each([403, 408, 409, 429, 500, undefined])('lets a %s status propagate as a server/other fault (false)', (status) => {
    expect(isClientError({ status })).toBe(false);
  });
});
