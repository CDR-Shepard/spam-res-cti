import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from '../routeTree.gen';
import { AuthProvider, useAuth } from '../lib/auth';
import { SELLER_ID, rowId, sellerView } from '../test/seller-fixtures';

vi.setConfig({ testTimeout: 15_000 });

const scrollSpy = vi.fn();
const realScrollTo = window.scrollTo;
/** Every wait names its timeout: the router and the page take a few renders to settle, and the machine is not always idle. */
const WAIT = { timeout: 5000 } as const;

beforeEach(() => {
  scrollSpy.mockClear();
  Element.prototype.scrollIntoView = scrollSpy;
  // jsdom's window.scrollTo only prints "Not implemented"; the router calls it when it lands on a page.
  window.scrollTo = vi.fn();
});

afterEach(() => {
  window.scrollTo = realScrollTo;
  vi.unstubAllGlobals();
  // @ts-expect-error jsdom does not define it: put it back the way it was.
  delete Element.prototype.scrollIntoView;
});

const SESSION = {
  token: 'tok',
  expiresAt: '2026-10-01T00:00:00.000Z',
  user: { userId: 'U1', orgId: 'O1', email: 'a@b.co', displayName: null, isAdmin: true, isSuperAdmin: false, kind: 'human' },
  tenant: { id: 'O1', name: 'GG Homes', slug: 'gg-homes', timezone: 'America/Los_Angeles', status: 'active' },
};
const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function mountAt(url: string, routes: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, '');
    const body = path === '/api/auth/session' ? SESSION : routes[path];
    return body === undefined ? jsonResponse(404, { error: 'nf', code: 'NOT_FOUND' }) : jsonResponse(200, body);
  }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({ routeTree, context: { auth: undefined!, queryClient }, history: createMemoryHistory({ initialEntries: [url] }) });
  function Inner() {
    const auth = useAuth();
    return <RouterProvider router={router} context={{ auth }} />;
  }
  render(<StrictMode><QueryClientProvider client={queryClient}><AuthProvider><Inner /></AuthProvider></QueryClientProvider></StrictMode>);
  return router;
}

/** Signs in through the callback route (the only way to seed a real AuthProvider here), then goes where the link points. */
async function signedInAt(target: { hash?: string }, routes: Record<string, unknown>) {
  const router = mountAt('/auth/callback?returnTo=/', routes);
  await waitFor(() => expect(router.state.location.pathname).toBe('/'), WAIT);
  await router.navigate({ to: '/sellers/$sfRecordId', params: { sfRecordId: SELLER_ID }, hash: target.hash });
  return router;
}

describe('/sellers/<sfRecordId>', () => {
  it('sits under the authenticated layout: a signed-out visit goes to sign-in and comes back to the same link, #event and all', async () => {
    const link = `/sellers/${SELLER_ID}#event-${rowId(2)}`;
    const router = mountAt(link, {});
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'), WAIT);
    expect(router.state.location.search).toMatchObject({ returnTo: link });
  });

  it('shows the seller inside the app shell, opened at the newest row', async () => {
    const router = await signedInAt({}, { [`/api/sellers/${SELLER_ID}/conversation`]: sellerView() });
    expect(await screen.findByRole('heading', { level: 1, name: 'Jane Seller' }, WAIT)).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(router.state.matches.map((m) => m.routeId)).toEqual(['__root__', '/_authenticated', '/_authenticated/sellers/$sfRecordId']);
    // The newest row is reached by moving the list, not the window: scrollIntoView is for the #event- link only.
    expect(await screen.findByRole('list', {}, WAIT)).toBeInTheDocument();
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('a #event-<id> link (what a Salesforce Task carries) opens on that row, marked, instead of the newest', async () => {
    await signedInAt({ hash: `event-${rowId(2)}` }, { [`/api/sellers/${SELLER_ID}/conversation`]: sellerView() });
    await screen.findByRole('heading', { level: 1, name: 'Jane Seller' }, WAIT);
    await waitFor(() => expect(document.getElementById(`event-${rowId(2)}`)).toHaveAttribute('data-highlighted', 'true'), WAIT);
    expect(scrollSpy.mock.contexts.map((el) => (el as HTMLElement).id)).toEqual([`event-${rowId(2)}`]);
  });
});
