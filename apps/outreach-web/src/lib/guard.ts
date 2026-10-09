import { isSafeReturnTo } from '@cti/contracts';

/** Pure guard used by the _authenticated layout's beforeLoad; returns a redirect target or null. */
export function authGuard(isAuthenticated: boolean, href: string): { to: '/sign-in'; search: { returnTo: string } } | null {
  return isAuthenticated ? null : { to: '/sign-in', search: { returnTo: href } };
}

/**
 * Pure guard used by the sign-in route's beforeLoad: someone who is already
 * signed in has nothing to do there, so send them on to `returnTo` — or home
 * when it is missing or not a safe in-app path (the route's search validation
 * already strips those; this re-checks, because a redirect is where an
 * off-site `returnTo` would do harm). Returns a redirect target or null.
 */
export function signedInGuard(isAuthenticated: boolean, returnTo: string | undefined): { href: string } | null {
  if (!isAuthenticated) return null;
  return { href: returnTo !== undefined && isSafeReturnTo(returnTo) ? returnTo : '/' };
}
