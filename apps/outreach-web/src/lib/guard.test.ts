import { describe, expect, it } from 'vitest';
import { authGuard, signedInGuard } from './guard';

describe('authGuard', () => {
  it('lets authenticated users through', () => {
    expect(authGuard(true, '/team')).toBeNull();
  });
  it('redirects anonymous users to sign-in with the return path', () => {
    expect(authGuard(false, '/team?x=1')).toEqual({ to: '/sign-in', search: { returnTo: '/team?x=1' } });
  });
});

describe('signedInGuard', () => {
  it('lets a signed-out visitor see the sign-in page', () => {
    expect(signedInGuard(false, '/team')).toBeNull();
    expect(signedInGuard(false, undefined)).toBeNull();
  });
  it('sends a signed-in visitor to a safe returnTo, query and hash intact', () => {
    expect(signedInGuard(true, '/team')).toEqual({ href: '/team' });
    expect(signedInGuard(true, '/team?tab=2#top')).toEqual({ href: '/team?tab=2#top' });
  });
  it('sends a signed-in visitor home when there is no returnTo', () => {
    expect(signedInGuard(true, undefined)).toEqual({ href: '/' });
  });
  it.each([['https://evil.example'], ['//evil.example'], ['/\\evil.example'], ['/api/auth/logout'], ['javascript:alert(1)'], ['']])(
    'sends a signed-in visitor home, never to the unsafe returnTo %j',
    (unsafe) => {
      expect(signedInGuard(true, unsafe)).toEqual({ href: '/' });
    },
  );
});
