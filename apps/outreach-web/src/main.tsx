import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { AuthProvider, useAuth } from './lib/auth';
import './index.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000 } } });
const router = createRouter({ routeTree, context: { auth: undefined!, queryClient }, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}

function App() {
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
  }, [auth.isAuthenticated]);
  return <RouterProvider router={router} context={{ auth }} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider><App /></AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
