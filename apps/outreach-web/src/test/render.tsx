import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { AuthContext, type AuthContextValue } from '../lib/auth';

export function renderWithProviders(ui: ReactElement, opts: { isAdmin?: boolean; isSuperAdmin?: boolean } = {}) {
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
  return render(<QueryClientProvider client={qc}><AuthContext.Provider value={auth}>{ui}</AuthContext.Provider></QueryClientProvider>);
}
