import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from '../routeTree.gen';
import { AuthProvider, useAuth } from '../lib/auth';

vi.setConfig({ testTimeout: 15_000 });

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const SESSION = {
  token: 'tok',
  expiresAt: '2026-10-01T00:00:00.000Z',
  user: { userId: 'U1', orgId: 'O1', email: 'a@b.co', displayName: null, isAdmin: false, isSuperAdmin: false, kind: 'human' },
  tenant: { id: 'O1', name: 'GG Homes', slug: 'gg-homes', timezone: 'America/Los_Angeles', status: 'active' },
};
const VERSION = { app: { commit: '1234567', startedAt: '2026-10-13T16:41:00.000Z' }, calls: null };

/** The real route tree, signed in through the callback route (as -routes.test.tsx does), answering API calls from `routes` by path. */
async function signedInApp(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    const body = url === '/api/auth/session' ? SESSION : routes[url];
    if (body === undefined) return new Response(JSON.stringify({ error: 'nf', code: 'NOT_FOUND' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({ routeTree, context: { auth: undefined!, queryClient }, history: createMemoryHistory({ initialEntries: ['/auth/callback?returnTo=/campaigns'] }) });
  function Inner() {
    const auth = useAuth();
    return <RouterProvider router={router} context={{ auth }} />;
  }
  render(<StrictMode><QueryClientProvider client={queryClient}><AuthProvider><Inner /></AuthProvider></QueryClientProvider></StrictMode>);
  await waitFor(() => expect(router.state.location.pathname).toBe('/campaigns'));
  return fetchMock;
}

describe('version tag in the signed-in layout', () => {
  it('every signed-in page carries it in the sidebar: the live app version, Calls unknown, and a refresh nudge for an older tab', async () => {
    vi.stubEnv('VITE_APP_COMMIT', '8a398bc');
    const fetchMock = await signedInApp({ '/api/campaigns': { campaigns: [] }, '/api/version': VERSION });
    expect(await screen.findByText('Calls unknown')).toBeInTheDocument();
    expect(screen.getByText('App 1234567')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New version — refresh' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain('/api/version');
  });

  it('a failing /api/version leaves the page alone: just "App <this tab>"', async () => {
    vi.stubEnv('VITE_APP_COMMIT', '8a398bc');
    const fetchMock = await signedInApp({ '/api/campaigns': { campaigns: [] } });
    expect(await screen.findByRole('heading', { name: 'Campaigns' })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain('/api/version'));
    expect(screen.getByText('App 8a398bc')).toBeInTheDocument();
    expect(screen.queryByText(/Calls/)).not.toBeInTheDocument();
  });
});
