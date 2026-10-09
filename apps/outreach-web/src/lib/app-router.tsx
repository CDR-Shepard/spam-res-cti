import { useEffect } from 'react';
import { RouterProvider, type AnyRouter } from '@tanstack/react-router';
import { useAuth } from './auth';

/**
 * Renders the router with the auth state in its context — but only once the
 * stored session has been restored. The `_authenticated` guard reads
 * `isAuthenticated`, which is `false` until `/api/auth/me` answers; letting it
 * run before then would bounce a signed-in user through `/sign-in` on every
 * reload. Rendering nothing for that moment (a request, usually under a
 * second) is the whole fix.
 */
export function AppRouter({ router }: { router: AnyRouter }) {
  const { restoring } = useAuth();
  return restoring ? null : <RoutedApp router={router} />;
}

function RoutedApp({ router }: { router: AnyRouter }) {
  const auth = useAuth();
  // `beforeLoad` (and so the `_authenticated` guard) only re-runs on a route
  // transition, not merely because `context.auth` changed underneath it — so
  // going from authenticated to not (a 401 mid-session, or signOut()) would
  // otherwise leave a protected page mounted with a dead session until the
  // user happens to navigate somewhere. Re-running `beforeLoad` for the
  // *current* route on every `isAuthenticated` transition is what actually
  // forces the redirect.
  useEffect(() => {
    void router.invalidate();
  }, [router, auth.isAuthenticated]);
  return <RouterProvider router={router} context={{ auth }} />;
}
