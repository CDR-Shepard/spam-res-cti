import { ApiError } from '@cti/contracts';
import type { z } from 'zod';

export class ApiRequestError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export interface ApiSession { token: string; orgId?: string }
let current: ApiSession | null = null;
/** In-memory bearer + the super admin's selected tenant. Cleared on reload by design (see spec §4.3). */
export const apiSession = {
  get: (): ApiSession | null => current,
  set: (s: ApiSession | null): void => { current = s; },
};

async function request(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (current?.token) headers.set('Authorization', `Bearer ${current.token}`);
  if (current?.orgId) headers.set('X-Org-Id', current.orgId);
  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => null);
    const parsed = ApiError.safeParse(body);
    throw new ApiRequestError(res.status, parsed.success ? parsed.data.code : 'UNKNOWN', parsed.success ? parsed.data.error : `HTTP ${res.status}`);
  }
  return res;
}

export async function api<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const res = await request(path, init);
  return schema.parse(await res.json());
}

export async function apiEmpty(path: string, init: RequestInit = {}): Promise<void> {
  await request(path, init);
}

export const json = (body: unknown): string => JSON.stringify(body);
