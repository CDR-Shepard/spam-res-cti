import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { AuthContext, type AuthContextValue } from '../lib/auth';

interface RenderOpts { isAdmin?: boolean; isSuperAdmin?: boolean }

function testProviders(opts: RenderOpts): { qc: QueryClient; auth: AuthContextValue } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const tenant = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', timezone: 'America/Los_Angeles', status: 'active' as const };
  const auth: AuthContextValue = {
    user: { userId: 'U1', orgId: 'O1', email: 'admin@gg.co', displayName: 'Admin', isAdmin: opts.isAdmin ?? false, isSuperAdmin: opts.isSuperAdmin ?? false, kind: 'human' },
    tenant,
    activeTenant: tenant,
    isAuthenticated: true,
    startSignIn: () => {},
    completeHandoff: async () => true,
    signOut: async () => {},
    switchTenant: () => {},
  };
  return { qc, auth };
}

export function renderWithProviders(ui: ReactElement, opts: RenderOpts = {}) {
  const { qc, auth } = testProviders(opts);
  return render(<QueryClientProvider client={qc}><AuthContext.Provider value={auth}>{ui}</AuthContext.Provider></QueryClientProvider>);
}

/**
 * `renderWithProviders` inside a one-route in-memory router, for components
 * that render `<Link>` or call `useNavigate`. The router mounts
 * asynchronously, so start assertions with a `findBy*` query.
 */
export function renderWithRouter(ui: ReactElement, opts: RenderOpts = {}) {
  const { qc, auth } = testProviders(opts);
  const router = createRouter({
    routeTree: createRootRoute({ component: () => ui }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const result = render(<QueryClientProvider client={qc}><AuthContext.Provider value={auth}><RouterProvider router={router} /></AuthContext.Provider></QueryClientProvider>);
  return { ...result, router };
}
