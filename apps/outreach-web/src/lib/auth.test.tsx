import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Tenant } from '@cti/contracts';
import { apiSession, SESSION_STORAGE_KEY } from './api';
import { AuthProvider, useAuth } from './auth';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); apiSession.set(null); localStorage.clear(); });

const otherTenant: Tenant = { id: 'O2', name: 'Other Co', slug: 'other-co', timezone: 'UTC', status: 'active' };

function SwitchButton() {
  const auth = useAuth();
  return <button onClick={() => auth.switchTenant(otherTenant)}>switch</button>;
}

describe('AuthProvider switchTenant', () => {
  it('clears the query cache so a previously cached query is gone after switching tenants', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['team'], { members: [] });
    expect(qc.getQueryData(['team'])).toEqual({ members: [] });

    render(
      <QueryClientProvider client={qc}>
        <AuthProvider><SwitchButton /></AuthProvider>
      </QueryClientProvider>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'switch' }));

    expect(qc.getQueryData(['team'])).toBeUndefined();
  });
});

describe('AuthProvider startSignIn', () => {
  function StartButtons({ returnTo }: { returnTo?: string }) {
    const auth = useAuth();
    return (
      <>
        <button onClick={() => auth.startSignIn(returnTo)}>default</button>
        <button onClick={() => auth.startSignIn(returnTo, 'workos')}>workos</button>
      </>
    );
  }
  afterEach(() => vi.unstubAllGlobals());

  it('navigates to the Salesforce start route by default and to WorkOS when asked, carrying an encoded returnTo', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider><StartButtons returnTo="/campaigns?x=1" /></AuthProvider>
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'default' }));
    await userEvent.click(screen.getByRole('button', { name: 'workos' }));
    expect(assign).toHaveBeenNthCalledWith(1, '/api/auth/salesforce/start?returnTo=%2Fcampaigns%3Fx%3D1');
    expect(assign).toHaveBeenNthCalledWith(2, '/api/auth/workos/start?returnTo=%2Fcampaigns%3Fx%3D1');
  });
});

describe('AuthProvider restore (stay signed in across a reload)', () => {
  const ME = {
    user: { userId: 'U1', orgId: 'O1', email: 'a@b.co', displayName: null, isAdmin: true, isSuperAdmin: false, kind: 'human' },
    tenant: { id: 'O1', name: 'GG Homes', slug: 'gg-homes', timezone: 'America/Los_Angeles', status: 'active' },
  };
  const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const pathOf = (input: RequestInfo | URL) => String(input).replace(/^https?:\/\/[^/]+/, '');

  function Probe() {
    const a = useAuth();
    return (
      <>
        <p>restoring:{String(a.restoring)}</p>
        <p>authenticated:{String(a.isAuthenticated)}</p>
        <p>user:{a.user?.email ?? 'none'}</p>
        <p>tenant:{a.tenant?.name ?? 'none'}</p>
        <p>active:{a.activeTenant?.name ?? 'none'}</p>
        <button onClick={() => void a.signOut()}>sign out</button>
        <button onClick={() => void a.completeHandoff()}>hand off</button>
      </>
    );
  }
  function renderProvider(strict = false) {
    const tree = (
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider><Probe /></AuthProvider>
      </QueryClientProvider>
    );
    return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  }
  /** A fetch whose `/api/auth/me` answer the test releases by hand. */
  function holdMe() {
    let release!: (r: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (pathOf(input) === '/api/auth/me' ? pending : jsonResponse(404, { error: 'nf', code: 'NOT_FOUND' })));
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, release };
  }
  const meCalls = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([u]) => pathOf(u as string) === '/api/auth/me');

  it('with no stored token, restoring is false on the first render and /me is never called', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderProvider();
    expect(screen.getByText('restoring:false')).toBeInTheDocument();
    expect(screen.getByText('authenticated:false')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with a stored token, restoring holds until /me answers, then user, tenant and activeTenant are filled', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, 'stored-tok');
    const { fetchMock, release } = holdMe();
    renderProvider();
    expect(screen.getByText('restoring:true')).toBeInTheDocument();
    expect(screen.getByText('authenticated:false')).toBeInTheDocument();
    await waitFor(() => expect(meCalls(fetchMock)).toHaveLength(1));
    const init = meCalls(fetchMock)[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer stored-tok');

    release(jsonResponse(200, ME));
    expect(await screen.findByText('restoring:false')).toBeInTheDocument();
    expect(screen.getByText('authenticated:true')).toBeInTheDocument();
    expect(screen.getByText('user:a@b.co')).toBeInTheDocument();
    expect(screen.getByText('tenant:GG Homes')).toBeInTheDocument();
    expect(screen.getByText('active:GG Homes')).toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe('stored-tok');
  });

  it('asks /me exactly once even under StrictMode', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, 'stored-tok');
    const fetchMock = vi.fn(async () => jsonResponse(200, ME));
    vi.stubGlobal('fetch', fetchMock);
    renderProvider(true);
    expect(await screen.findByText('user:a@b.co')).toBeInTheDocument();
    expect(meCalls(fetchMock)).toHaveLength(1);
  });

  it('a 401 clears the stored token and leaves the user signed out', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, 'expired-tok');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'Sign in required', code: 'UNAUTHENTICATED' })));
    renderProvider();
    expect(await screen.findByText('restoring:false')).toBeInTheDocument();
    expect(screen.getByText('authenticated:false')).toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(apiSession.get()).toBeNull();
  });

  it('a network error keeps the stored token (the user is only signed out of this view; the next load retries)', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, 'stored-tok');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    renderProvider();
    expect(await screen.findByText('restoring:false')).toBeInTheDocument();
    expect(screen.getByText('authenticated:false')).toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe('stored-tok');
  });

  it('a 503 (the API mid-deploy) keeps the stored token too', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, 'stored-tok');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 503 })));
    renderProvider();
    expect(await screen.findByText('restoring:false')).toBeInTheDocument();
    expect(screen.getByText('authenticated:false')).toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe('stored-tok');
  });

  it('a /me body that is not the expected shape does not sign anyone in or drop the token', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, 'stored-tok');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { unexpected: true })));
    renderProvider();
    expect(await screen.findByText('restoring:false')).toBeInTheDocument();
    expect(screen.getByText('authenticated:false')).toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe('stored-tok');
  });

  it('completing the sign-in handoff stores the token so the next load restores it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { ...ME, token: 'fresh-tok', expiresAt: '2026-11-08T00:00:00.000Z' })));
    renderProvider();
    await userEvent.click(screen.getByRole('button', { name: 'hand off' }));
    expect(await screen.findByText('user:a@b.co')).toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe('fresh-tok');
  });

  it('sign out revokes the session on the server and clears the stored token', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, 'stored-tok');
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => (pathOf(input) === '/api/auth/me' ? jsonResponse(200, ME) : new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);
    renderProvider();
    expect(await screen.findByText('user:a@b.co')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'sign out' }));

    expect(await screen.findByText('user:none')).toBeInTheDocument();
    const logout = fetchMock.mock.calls.find(([u]) => pathOf(u) === '/api/auth/logout')!;
    expect((logout[1] as RequestInit).method).toBe('POST');
    expect(new Headers((logout[1] as RequestInit).headers).get('authorization')).toBe('Bearer stored-tok');
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(apiSession.get()).toBeNull();
  });

  it('sign out clears the stored token even when the server cannot be reached', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, 'stored-tok');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (pathOf(input) === '/api/auth/me') return jsonResponse(200, ME);
      throw new TypeError('Failed to fetch');
    }));
    renderProvider();
    expect(await screen.findByText('user:a@b.co')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'sign out' }));
    expect(await screen.findByText('user:none')).toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it('a 403 TENANT_FORBIDDEN from /me clears the stored token: that session will never work', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, 'stored-tok');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, { error: 'Unknown tenant', code: 'TENANT_FORBIDDEN' })));
    renderProvider();
    expect(await screen.findByText('restoring:false')).toBeInTheDocument();
    expect(screen.getByText('authenticated:false')).toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(apiSession.get()).toBeNull();
  });

  it('any other 403 keeps the stored token', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, 'stored-tok');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, { error: 'Nope', code: 'FORBIDDEN' })));
    renderProvider();
    expect(await screen.findByText('restoring:false')).toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe('stored-tok');
  });

  it('bounds the restore request at 10 s: a hung API times out, the token is kept and the user lands on the signed-out view', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, 'stored-tok');
    const clock = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(clock.signal);
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));
    vi.stubGlobal('fetch', fetchMock);
    renderProvider();
    expect(screen.getByText('restoring:true')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);

    clock.abort(new DOMException('timed out', 'TimeoutError'));
    expect(await screen.findByText('restoring:false')).toBeInTheDocument();
    expect(screen.getByText('authenticated:false')).toBeInTheDocument();
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe('stored-tok');
  });
});

describe('AuthProvider cross-tab sign-in changes', () => {
  const ME = {
    user: { userId: 'U1', orgId: 'O1', email: 'a@b.co', displayName: null, isAdmin: true, isSuperAdmin: false, kind: 'human' },
    tenant: { id: 'O1', name: 'GG Homes', slug: 'gg-homes', timezone: 'America/Los_Angeles', status: 'active' },
  };
  const fromOtherTab = (init: StorageEventInit) => window.dispatchEvent(new StorageEvent('storage', init));

  async function signedInTab() {
    localStorage.setItem(SESSION_STORAGE_KEY, 'stored-tok');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(ME), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider><p>child</p></AuthProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(apiSession.get()).toEqual({ token: 'stored-tok' }));
    return { reload, ...view };
  }

  it('reloads when another tab signs in as someone else, so this tab never keeps acting for a different identity under stale UI', async () => {
    const { reload } = await signedInTab();
    fromOtherTab({ key: SESSION_STORAGE_KEY, newValue: 'theirs', oldValue: 'stored-tok' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads when another tab signs out', async () => {
    const { reload } = await signedInTab();
    fromOtherTab({ key: SESSION_STORAGE_KEY, newValue: null, oldValue: 'stored-tok' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload for this tab's own token or for unrelated keys", async () => {
    const { reload } = await signedInTab();
    fromOtherTab({ key: SESSION_STORAGE_KEY, newValue: 'stored-tok' });
    fromOtherTab({ key: 'theme', newValue: 'dark' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('stops listening when the provider unmounts', async () => {
    const { reload, unmount } = await signedInTab();
    unmount();
    fromOtherTab({ key: SESSION_STORAGE_KEY, newValue: 'theirs' });
    expect(reload).not.toHaveBeenCalled();
  });
});
