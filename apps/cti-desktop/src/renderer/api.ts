import type { ApiResponse } from '../shared/ipc';

export class ApiError extends Error {
  constructor(public status: number, public data: unknown) {
    super(`API ${status}: ${typeof data === 'object' ? JSON.stringify(data) : String(data)}`);
  }
}

export async function api<T = unknown>(
  path: string,
  init?: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; authed?: boolean },
): Promise<T> {
  const res: ApiResponse<T> = await window.cti.apiRequest<T>(path, init);
  if (!res.ok) throw new ApiError(res.status, res.data);
  return res.data;
}
