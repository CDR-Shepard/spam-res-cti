import { ApiError } from '@cti/contracts';
import type { z } from 'zod';

export class ApiRequestError extends Error {
  /** `details` is the error envelope's own (e.g. a 429's `retryAt`), unparsed. */
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export interface ApiSession { token: string; orgId?: string }

/** Where the bearer survives a reload and a browser restart (localStorage, not sessionStorage). */
export const SESSION_STORAGE_KEY = 'outreach.session.v1';

/** This tab's copy of the session: what carries it when storage is unavailable, and where the selected `orgId` lives. */
let memory: ApiSession | null = null;

/** The stored bearer, or null when none is stored or storage is unavailable (private mode, blocked cookies). */
function readStoredToken(): string | null {
  try { return localStorage.getItem(SESSION_STORAGE_KEY) || null; } catch { return null; }
}

function writeStoredToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(SESSION_STORAGE_KEY, token);
    else localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch { /* storage refused: the in-memory copy still carries this tab, it just won't survive a reload */ }
}

/**
 * The bearer plus the super admin's selected tenant. The bearer is kept in
 * localStorage so a reload (or a browser restart) leaves you signed in; the
 * trade-off — a script on the page could read it — was accepted by the owner.
 * `orgId` is deliberately NOT stored: a reload returns to the home tenant,
 * which is what `AuthProvider`'s restore shows. Every storage call is
 * guarded and falls back to memory.
 */
export const apiSession = {
  get: (): ApiSession | null => {
    const stored = readStoredToken();
    if (!stored) return memory;
    // The same token keeps this tab's selected org; a different one (another tab signed in, or a reload) starts clean.
    return memory?.token === stored ? memory : { token: stored };
  },
  set: (s: ApiSession | null): void => {
    memory = s;
    writeStoredToken(s?.token ?? null);
  },
};

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;
/**
 * Registered by `AuthProvider`: a 401 anywhere drops the local session by
 * flipping the React auth state to signed-out. That flip is what actually
 * triggers the redirect — `main.tsx` re-runs the `_authenticated` guard's
 * `beforeLoad` whenever `isAuthenticated` changes (see its
 * `router.invalidate()` effect); clearing the state here doesn't redirect
 * anything by itself.
 */
export function setUnauthorizedHandler(fn: UnauthorizedHandler | null): void {
  unauthorizedHandler = fn;
}

/** `GET /api/auth/session` legitimately 401s before a session exists (e.g. a stale/replayed callback) — that's not "was signed in, got kicked out". */
function isSessionBootstrap(path: string, method: string): boolean {
  return method === 'GET' && path === '/api/auth/session';
}

async function request(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const session = apiSession.get();
  if (session?.token) headers.set('Authorization', `Bearer ${session.token}`);
  if (session?.orgId) headers.set('X-Org-Id', session.orgId);
  const method = (init.method ?? 'GET').toUpperCase();
  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (res.status === 401 && !isSessionBootstrap(path, method)) {
    apiSession.set(null);
    unauthorizedHandler?.();
  }
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const parsed = ApiError.safeParse(body);
    throw new ApiRequestError(res.status, parsed.success ? parsed.data.code : 'UNKNOWN', parsed.success ? parsed.data.error : `HTTP ${res.status}`, parsed.success ? parsed.data.details : undefined);
  }
  return res;
}

/** `unknown` input: a schema with `.default()` (e.g. CallPlan's 1D fields) parses to a type unlike its input. */
export async function api<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, init: RequestInit = {}): Promise<T> {
  const res = await request(path, init);
  return schema.parse(await res.json());
}

export async function apiEmpty(path: string, init: RequestInit = {}): Promise<void> {
  await request(path, init);
}

export const json = (body: unknown): string => JSON.stringify(body);
