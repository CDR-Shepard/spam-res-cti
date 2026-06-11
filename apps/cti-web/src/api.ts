/**
 * Fetch-based API client. Backend base URL is configured at build time via
 * VITE_API_BASE_URL, or — when served by our own API behind the same origin —
 * defaults to the current page's origin so relative paths Just Work.
 */
const SESSION_KEY = 'cti.session.v1';

export const API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  (typeof window !== 'undefined' ? window.location.origin : '');

export class ApiError extends Error {
  constructor(public status: number, public data: unknown) {
    super(`API ${status}: ${typeof data === 'object' ? JSON.stringify(data) : String(data)}`);
  }
}

export interface StoredSession { token: string; userId: string; email: string }

export function readSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredSession;
  } catch { return null; }
}
export function writeSession(s: StoredSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}
export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
}

export async function api<T = unknown>(
  path: string,
  init?: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; authed?: boolean },
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.authed !== false) {
    const s = readSession();
    if (s) headers.authorization = `Bearer ${s.token}`;
  }
  if (init?.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}
