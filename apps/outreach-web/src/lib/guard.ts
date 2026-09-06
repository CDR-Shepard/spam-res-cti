/** Pure guard used by the _authenticated layout's beforeLoad; returns a redirect target or null. */
export function authGuard(isAuthenticated: boolean, href: string): { to: '/sign-in'; search: { returnTo: string } } | null {
  return isAuthenticated ? null : { to: '/sign-in', search: { returnTo: href } };
}
