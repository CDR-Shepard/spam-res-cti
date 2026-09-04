import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, type AnyRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from '../routeTree.gen';
import { AuthProvider, useAuth } from '../lib/auth';

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
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeInTheDocument();
  });
});

describe('sign-in returnTo validation', () => {
  it.each([['//evil.com'], ['/%5Cevil.com']])(
    'strips an unsafe returnTo (%s) and falls back to a plain Continue that does not carry it forward',
    async (unsafeReturnTo) => {
      const { assign: assignSpy } = stubLocationMethods();
      const router = renderAppAt(`/sign-in?returnTo=${unsafeReturnTo}`);
      await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
      // The invalid value must not survive into the parsed search...
      expect(router.state.location.search).toEqual({});
      // ...nor appear anywhere in the rendered page...
      expect(screen.queryByText(/evil/i)).not.toBeInTheDocument();
      const button = await screen.findByRole('button', { name: 'Continue' });
      await userEvent.click(button);
      // ...nor leak into the redirect this page triggers.
      expect(assignSpy).toHaveBeenCalledWith('/api/auth/workos/start');
    },
  );
});

describe('auth callback', () => {
  it('exchanges the session exactly once (even under StrictMode) and replaces the location with returnTo', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      token: 'tok',
      expiresAt: '2026-10-01T00:00:00.000Z',
      user: { userId: 'U1', orgId: 'O1', email: 'a@b.co', displayName: null, isAdmin: false, isSuperAdmin: false, kind: 'human' },
      tenant: { id: 'O1', name: 'GG Homes', slug: 'gg-homes', timezone: 'America/Los_Angeles', status: 'active' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { replace: replaceSpy } = stubLocationMethods();

    renderAppAt('/auth/callback?returnTo=/team');

    await waitFor(() => expect(replaceSpy).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(replaceSpy).toHaveBeenCalledWith('/team');
  });
});
