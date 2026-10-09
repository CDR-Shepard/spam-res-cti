import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { MeResponse, SessionResponse, type SessionUser, type Tenant } from '@cti/contracts';
import { api, apiEmpty, ApiRequestError, apiSession, isSessionChangedElsewhere, setUnauthorizedHandler } from './api';

/** Which sign-in the browser starts: the API's `/api/auth/<provider>/start`. Salesforce is the default. */
export type SignInProvider = 'salesforce' | 'workos';

export interface AuthContextValue {
  user: SessionUser | null;
  /** The tenant the session belongs to. */
  tenant: Tenant | null;
  /** The tenant requests act on (differs from `tenant` only for super admins who switched). */
  activeTenant: Tenant | null;
  isAuthenticated: boolean;
  /**
   * True until the attempt to restore a stored session has finished; false from
   * the first render when none is stored. While true, `isAuthenticated` is not
   * yet the answer, so nothing that redirects on it (the route guard) may run.
   */
  restoring: boolean;
  startSignIn: (returnTo?: string, provider?: SignInProvider) => void;
  completeHandoff: () => Promise<boolean>;
  signOut: () => Promise<void>;
  switchTenant: (tenant: Tenant) => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

/** A hung API must not leave the page blank forever: past this the restore gives up and shows the signed-out view. */
const RESTORE_TIMEOUT_MS = 10_000;

/** `/me` says the session's tenant no longer exists: that token will never work, unlike an outage. */
function isUnusableSession(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 403 && err.code === 'TENANT_FORBIDDEN';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [activeTenant, setActiveTenant] = useState<Tenant | null>(null);
  // A stored bearer means the first answer to "who is signed in?" is still a request away.
  const [restoring, setRestoring] = useState(() => apiSession.restore() !== null);

  /** A signed-in session starts on its own tenant: `activeTenant` only differs after `switchTenant`. */
  const adopt = useCallback((u: SessionUser, t: Tenant) => {
    setUser(u);
    setTenant(t);
    setActiveTenant(t);
  }, []);

  const startSignIn = useCallback((returnTo?: string, provider: SignInProvider = 'salesforce') => {
    const q = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : '';
    window.location.assign(`/api/auth/${provider}/start${q}`);
  }, []);

  const completeHandoff = useCallback(async () => {
    try {
      const s = await api('/api/auth/session', SessionResponse);
      apiSession.set({ token: s.token });
      adopt(s.user, s.tenant);
      return true;
    } catch {
      return false;
    }
  }, [adopt]);

  const signOut = useCallback(async () => {
    try { await apiEmpty('/api/auth/logout', { method: 'POST' }); } catch { /* already signed out */ }
    apiSession.set(null);
    setUser(null); setTenant(null); setActiveTenant(null);
  }, []);

  const switchTenant = useCallback((t: Tenant) => {
    const s = apiSession.get();
    if (s) apiSession.set({ token: s.token, orgId: t.id === tenant?.id ? undefined : t.id });
    setActiveTenant(t);
    // Every cached query (team roster, invites, dashboard data, ...) was
    // fetched for the *previous* tenant. Without this, a super admin who
    // switches tenants would briefly see stale data from the old one
    // rendered under the new tenant's chrome until each query refetches.
    queryClient.clear();
  }, [tenant, queryClient]);

  // A 401 from any authenticated request (session expired, revoked
  // elsewhere, etc.) drops the local session, flipping `isAuthenticated` to
  // false. That alone doesn't redirect anything — it's `main.tsx`'s
  // `useEffect` (keyed on `isAuthenticated`, calling `router.invalidate()`)
  // that re-runs the `_authenticated` layout's `beforeLoad` and sends the
  // guard to sign-in instead of leaving the current page rendered with a
  // now-invalid bearer.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setTenant(null);
      setActiveTenant(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  // A reload (or a browser restart) loses React state but not the stored
  // bearer: ask the API who it belongs to and sign that user back in. A 401
  // already dropped the stored token (api.ts), and so does a TENANT_FORBIDDEN
  // (it will never work); any other failure (offline, a timeout, the API
  // mid-deploy) leaves it for the next load to retry. Either way the user
  // lands signed out for now rather than stuck. The ref keeps StrictMode's
  // double-invoked effect to one request.
  const restoreStarted = useRef(false);
  useEffect(() => {
    if (restoreStarted.current || !restoring) return;
    restoreStarted.current = true;
    const token = apiSession.get()?.token;
    api('/api/auth/me', MeResponse, { signal: AbortSignal.timeout(RESTORE_TIMEOUT_MS) })
      .then((me) => adopt(me.user, me.tenant))
      .catch((err: unknown) => { if (token && isUnusableSession(err)) apiSession.clearIfToken(token); })
      .finally(() => setRestoring(false));
  }, [restoring, adopt]);

  // Another tab signed in as someone else, or out: this tab's token no longer
  // matches storage and its UI (active tenant, cached queries) would be stale
  // against whoever it silently became. Start over from storage.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (isSessionChangedElsewhere(e)) window.location.reload(); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const value = useMemo<AuthContextValue>(() => ({ user, tenant, activeTenant, isAuthenticated: user != null, restoring, startSignIn, completeHandoff, signOut, switchTenant }), [user, tenant, activeTenant, restoring, startSignIn, completeHandoff, signOut, switchTenant]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
