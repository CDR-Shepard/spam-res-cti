import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { SessionResponse, type SessionUser, type Tenant } from '@cti/contracts';
import { api, apiEmpty, apiSession } from './api';

export interface AuthContextValue {
  user: SessionUser | null;
  /** The tenant the session belongs to. */
  tenant: Tenant | null;
  /** The tenant requests act on (differs from `tenant` only for super admins who switched). */
  activeTenant: Tenant | null;
  isAuthenticated: boolean;
  startSignIn: (returnTo?: string) => void;
  completeHandoff: () => Promise<boolean>;
  signOut: () => Promise<void>;
  switchTenant: (tenant: Tenant) => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [activeTenant, setActiveTenant] = useState<Tenant | null>(null);

  const startSignIn = useCallback((returnTo?: string) => {
    const q = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : '';
    window.location.assign(`/api/auth/workos/start${q}`);
  }, []);

  const completeHandoff = useCallback(async () => {
    try {
      const s = await api('/api/auth/session', SessionResponse);
      apiSession.set({ token: s.token });
      setUser(s.user);
      setTenant(s.tenant);
      setActiveTenant(s.tenant);
      return true;
    } catch {
      return false;
    }
  }, []);

  const signOut = useCallback(async () => {
    try { await apiEmpty('/api/auth/logout', { method: 'POST' }); } catch { /* already signed out */ }
    apiSession.set(null);
    setUser(null); setTenant(null); setActiveTenant(null);
  }, []);

  const switchTenant = useCallback((t: Tenant) => {
    const s = apiSession.get();
    if (s) apiSession.set({ token: s.token, orgId: t.id === tenant?.id ? undefined : t.id });
    setActiveTenant(t);
  }, [tenant]);

  const value = useMemo<AuthContextValue>(() => ({ user, tenant, activeTenant, isAuthenticated: user != null, startSignIn, completeHandoff, signOut, switchTenant }), [user, tenant, activeTenant, startSignIn, completeHandoff, signOut, switchTenant]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
