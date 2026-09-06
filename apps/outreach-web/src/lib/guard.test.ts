import { describe, expect, it } from 'vitest';
import { authGuard } from './guard';

describe('authGuard', () => {
  it('lets authenticated users through', () => {
    expect(authGuard(true, '/team')).toBeNull();
  });
  it('redirects anonymous users to sign-in with the return path', () => {
    expect(authGuard(false, '/team?x=1')).toEqual({ to: '/sign-in', search: { returnTo: '/team?x=1' } });
  });
});
