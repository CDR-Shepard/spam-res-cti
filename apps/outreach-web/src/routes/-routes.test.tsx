import { StrictMode, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, type AnyRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from '../routeTree.gen';
import { AuthProvider, useAuth } from '../lib/auth';

// Sweep D-12: these tests time out at the 5 s default under the full parallel root run (they pass alone); no logic change.
vi.setConfig({ testTimeout: 15_000 });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/**
 * jsdom's `window.location.assign`/`.replace` are non-configurable own
 * properties, so `vi.spyOn` (which needs to redefine them) throws
 * "Cannot redefine property". The whole `location` property on `window`
 * *is* configurable, so replace the object wholesale with fakes instead.
 */
function stubLocationMethods(): { assign: ReturnType<typeof vi.fn>; replace: ReturnType<typeof vi.fn> } {
  const assign = vi.fn();
  const replace = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, assign, replace },
  });
  return { assign, replace };
}

/** Renders the real route tree at `initialUrl` under a real `AuthProvider`, using an in-memory history so nothing touches the jsdom URL bar. Returns the router instance so tests can inspect `router.state.location`. */
function renderAppAt(initialUrl: string): AnyRouter {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { auth: undefined!, queryClient },
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
  function Inner() {
    const auth = useAuth();
    // Mirrors main.tsx's App(): re-run the current route's `beforeLoad`
    // whenever `isAuthenticated` changes, so a mid-session 401 (or signOut())
    // redirects immediately instead of only on the next navigation.
    useEffect(() => {
      void router.invalidate();
    }, [auth.isAuthenticated]);
    return <RouterProvider router={router} context={{ auth }} />;
  }
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AuthProvider><Inner /></AuthProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
  return router;
}

describe('router guard', () => {
  it('redirects an unauthenticated visit to /team to /sign-in with the return path', async () => {
    const router = renderAppAt('/team');
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(router.state.location.search).toMatchObject({ returnTo: '/team' });
    expect(await screen.findByRole('button', { name: 'Sign in with Salesforce' })).toBeInTheDocument();
  });
});

describe('sign-in returnTo validation', () => {
  it.each([['//evil.com'], ['/%5Cevil.com']])(
    'strips an unsafe returnTo (%s) and falls back to a plain sign-in that does not carry it forward',
    async (unsafeReturnTo) => {
      const { assign: assignSpy } = stubLocationMethods();
      const router = renderAppAt(`/sign-in?returnTo=${unsafeReturnTo}`);
      await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
      // The invalid value must not survive into the parsed search...
      expect(router.state.location.search).toEqual({});
      // ...nor appear anywhere in the rendered page...
      expect(screen.queryByText(/evil/i)).not.toBeInTheDocument();
      const button = await screen.findByRole('button', { name: 'Sign in with Salesforce' });
      await userEvent.click(button);
      // ...nor leak into the redirect this page triggers.
      expect(assignSpy).toHaveBeenCalledWith('/api/auth/salesforce/start');
    },
  );
});

describe('router guard re-run on 401', () => {
  it('redirects to /sign-in the moment an authenticated request 401s, without any user navigation', async () => {
    const sessionBody = {
      token: 'tok',
      expiresAt: '2026-10-01T00:00:00.000Z',
      user: { userId: 'U1', orgId: 'O1', email: 'a@b.co', displayName: null, isAdmin: false, isSuperAdmin: false, kind: 'human' },
      tenant: { id: 'O1', name: 'GG Homes', slug: 'gg-homes', timezone: 'America/Los_Angeles', status: 'active' },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input).replace(/^https?:\/\/[^/]+/, '');
      if (url === '/api/auth/session') return new Response(JSON.stringify(sessionBody), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/team') return new Response(JSON.stringify({ error: 'Session expired', code: 'UNAUTHENTICATED' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    stubLocationMethods(); // neutralize `replace`/`assign` so nothing actually navigates the jsdom window

    // Establish an authenticated session the same way the real app does (via
    // the callback route — there's no other way to seed an authenticated
    // AuthProvider through this harness), then move to /team the same way a
    // post-callback page load would have landed there.
    const router = renderAppAt('/auth/callback?returnTo=/team');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', expect.anything()));
    await router.navigate({ to: '/team' });

    // TeamPage's `GET /api/team` 401s; nothing in this test calls
    // `router.navigate` again — the redirect below must come from the guard
    // re-running on its own once `isAuthenticated` flips to false.
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(router.state.location.search).toMatchObject({ returnTo: '/team' });
  });
});

describe('auth callback', () => {
  it('exchanges the session exactly once (even under StrictMode) and lands on returnTo signed in, without a page reload', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input).replace(/^https?:\/\/[^/]+/, '');
      const body = url === '/api/auth/session'
        ? {
            token: 'tok',
            expiresAt: '2026-10-01T00:00:00.000Z',
            user: { userId: 'U1', orgId: 'O1', email: 'a@b.co', displayName: null, isAdmin: false, isSuperAdmin: false, kind: 'human' },
            tenant: { id: 'O1', name: 'GG Homes', slug: 'gg-homes', timezone: 'America/Los_Angeles', status: 'active' },
          }
        : { error: 'nf', code: 'NOT_FOUND' };
      return new Response(JSON.stringify(body), { status: url === '/api/auth/session' ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { replace: replaceSpy, assign: assignSpy } = stubLocationMethods();

    const router = renderAppAt('/auth/callback?returnTo=/team');

    // The bearer lives in memory only, so a full reload (location.replace) would drop it and bounce back to sign-in.
    await waitFor(() => expect(router.state.location.pathname).toBe('/team'));
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/auth/session'))).toHaveLength(1);
  });
});

const SIGNED_IN_SESSION = {
  token: 'tok',
  expiresAt: '2026-10-01T00:00:00.000Z',
  user: { userId: 'U1', orgId: 'O1', email: 'a@b.co', displayName: null, isAdmin: true, isSuperAdmin: false, kind: 'human' },
  tenant: { id: 'O1', name: 'GG Homes', slug: 'gg-homes', timezone: 'America/Los_Angeles', status: 'active' },
};

/** Signs in through the callback route (the only way to seed a real AuthProvider here), answering API calls from `routes` by path. */
async function signedInAppAt(routes: Record<string, unknown>): Promise<AnyRouter> {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    const body = url === '/api/auth/session' ? SIGNED_IN_SESSION : routes[url];
    if (body === undefined) return new Response(JSON.stringify({ error: 'nf', code: 'NOT_FOUND' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  stubLocationMethods();
  const router = renderAppAt('/auth/callback?returnTo=/');
  await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  return router;
}

describe('outreach pages', () => {
  it.each([
    ['/campaigns'],
    ['/campaigns/new'],
    ['/campaigns/11111111-1111-4111-8111-111111111111'],
    ['/settings/connections'],
    ['/review'],
    ['/test-record'],
  ])('%s sits under the authenticated layout (signed-out visits go to sign-in)', async (path) => {
    const router = renderAppAt(path);
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(router.state.location.search).toMatchObject({ returnTo: path });
  });

  it('renders /campaigns inside the app shell with the outreach nav once signed in', async () => {
    const router = await signedInAppAt({ '/api/campaigns': { campaigns: [] } });
    await router.navigate({ to: '/campaigns' });
    expect(await screen.findByRole('heading', { name: 'Campaigns' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Dashboard', 'Campaigns', 'Needs review', 'Team', 'Test a record', 'Settings']);
    expect(router.state.matches.map((m) => m.routeId)).toEqual(['__root__', '/_authenticated', '/_authenticated/campaigns/']);
  });

  it('/test-record keeps a uuid ?id= and drops anything else', async () => {
    const router = await signedInAppAt({ '/api/record-tests': { items: [] } });
    await router.navigate({ to: '/test-record', search: { id: 'not-a-uuid' } as never });
    expect(await screen.findByRole('heading', { name: 'Test a record' })).toBeInTheDocument();
    expect(await screen.findByText('No tests yet.')).toBeInTheDocument();
    // The bad id never reaches the page: no test is read and none is shown.
    expect(vi.mocked(fetch).mock.calls.map(([u]) => String(u)).filter((u) => u.includes('not-a-uuid'))).toEqual([]);
    expect(screen.queryByText('Loading the test…')).not.toBeInTheDocument();
    const id = '55555555-5555-4555-8555-555555555555';
    await router.navigate({ to: '/test-record', search: { id } });
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.map(([u]) => String(u))).toContain(`/api/record-tests/${id}`));
    expect(router.state.matches.map((m) => m.routeId)).toEqual(['__root__', '/_authenticated', '/_authenticated/test-record']);
  });

  it('turns the Salesforce callback query into a message on the connections page', async () => {
    const notConnected = { configured: true, connected: false, status: null, instanceUrl: null, username: null, connectedAt: null, lastError: null, fieldMap: null };
    const router = await signedInAppAt({ '/api/connections/salesforce': notConnected });
    router.history.push('/settings/connections?connected=1');
    expect(await screen.findByText('Salesforce is connected.')).toBeInTheDocument();
    router.history.push('/settings/connections?error=access_denied');
    expect(await screen.findByText('Salesforce sign-in was cancelled.')).toBeInTheDocument();
  });
});
