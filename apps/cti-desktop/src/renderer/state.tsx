import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, ApiError } from './api';

export interface SessionState {
  token: string | null;
  userId: string | null;
  email: string | null;
}

export interface MeResponse {
  user: { userId: string; orgId: string; email: string };
  salesforce:
    | { connected: false }
    | {
        connected: true;
        instanceUrl: string;
        sfUserId: string;
        sfOrgId: string;
        scope?: string;
        updatedAt: string;
        name?: string | null;
        email?: string | null;
        photoDataUrl?: string | null;
      };
}

export type ToastKind = 'info' | 'error' | 'success';
export interface Toast { text: string; type: ToastKind }

export type Theme = 'dark' | 'light';
const THEME_STORAGE_KEY = 'cti.theme';
const DISPLAY_NAME_STORAGE_KEY = 'cti.displayName';

function loadTheme(): Theme {
  if (typeof localStorage === 'undefined') return 'light';
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  // Default to light unless the user has explicitly chosen dark.
  return stored === 'dark' ? 'dark' : 'light';
}

function loadCustomDisplayName(): string | null {
  if (typeof localStorage === 'undefined') return null;
  const v = localStorage.getItem(DISPLAY_NAME_STORAGE_KEY);
  return v && v.trim() ? v.trim() : null;
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

interface AppContextValue {
  session: SessionState;
  me: MeResponse | null;
  ready: boolean;
  toast: Toast | null;
  setToast: (t: Toast | null) => void;
  refreshMe: () => Promise<void>;
  signInDev: () => Promise<void>;
  signOut: () => Promise<void>;
  theme: Theme;
  setTheme: (t: Theme) => void;
  /** Bumped each time a tel: URL arrives; the dialer reacts to it. */
  incomingTel: { number: string; nonce: number } | null;
  /** User-set display name (overrides SF/email fallbacks). */
  customDisplayName: string | null;
  setCustomDisplayName: (name: string | null) => void;
}

const Ctx = createContext<AppContextValue | null>(null);

export function AppProvider(props: { children: React.ReactNode }): JSX.Element {
  const [session, setSession] = useState<SessionState>({ token: null, userId: null, email: null });
  const [me, setMe] = useState<MeResponse | null>(null);
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [theme, setThemeState] = useState<Theme>(loadTheme);
  const [incomingTel, setIncomingTel] = useState<{ number: string; nonce: number } | null>(null);
  const [customDisplayName, setCustomDisplayNameState] = useState<string | null>(loadCustomDisplayName);

  const setCustomDisplayName = useCallback((name: string | null) => {
    setCustomDisplayNameState(name);
    try {
      if (name && name.trim()) localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, name.trim());
      else localStorage.removeItem(DISPLAY_NAME_STORAGE_KEY);
    } catch { /* ignore */ }
  }, []);

  // Apply the stored theme on first paint, then any time it changes.
  useEffect(() => { applyTheme(theme); }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try { localStorage.setItem(THEME_STORAGE_KEY, t); } catch { /* ignore */ }
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      const data = await api<MeResponse>('/auth/me');
      setMe(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setMe(null);
      } else {
        setToast({ text: `Could not load profile: ${(err as Error).message}`, type: 'error' });
      }
    }
  }, []);

  const signInDev = useCallback(async () => {
    const data = await api<{ token: string; user: { id: string; email: string } }>(
      '/auth/dev-session',
      { method: 'POST', authed: false },
    );
    await window.cti.saveSession(data.token, data.user.id, data.user.email);
    setSession({ token: data.token, userId: data.user.id, email: data.user.email });
    await refreshMe();
  }, [refreshMe]);

  const signOut = useCallback(async () => {
    await window.cti.clearSession();
    setSession({ token: null, userId: null, email: null });
    setMe(null);
  }, []);

  useEffect(() => {
    void (async () => {
      const s = await window.cti.getSession();
      setSession(s);
      if (s.token) await refreshMe();
      setReady(true);
    })();
  }, [refreshMe]);

  // Wire the tel: URL handler: subscribe to new ones + drain any buffered.
  useEffect(() => {
    let mounted = true;
    const unsub = window.cti.onTelUrl((number) => {
      setIncomingTel({ number, nonce: Date.now() });
    });
    void window.cti.consumePendingTel().then((number) => {
      if (mounted && number) setIncomingTel({ number, nonce: Date.now() });
    });
    return () => { mounted = false; unsub(); };
  }, []);

  // Auto-clear toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <Ctx.Provider value={{ session, me, ready, toast, setToast, refreshMe, signInDev, signOut, theme, setTheme, incomingTel, customDisplayName, setCustomDisplayName }}>
      {props.children}
    </Ctx.Provider>
  );
}

export function useApp(): AppContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppContext missing');
  return v;
}
