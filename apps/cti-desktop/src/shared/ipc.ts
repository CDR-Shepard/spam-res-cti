/**
 * IPC contract between renderer and main process.
 * The preload bridge exposes a single `window.cti` object with these methods.
 */
export interface ApiRequestInit {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** When false, do not attach the session bearer (e.g., /auth/dev-session). */
  authed?: boolean;
}

export interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
}

export interface CtiBridge {
  apiRequest<T = unknown>(path: string, init?: ApiRequestInit): Promise<ApiResponse<T>>;
  openExternal(url: string): Promise<void>;
  getSession(): Promise<{ token: string | null; userId: string | null; email: string | null }>;
  saveSession(token: string, userId: string, email: string): Promise<void>;
  clearSession(): Promise<void>;
  appVersion(): Promise<string>;
  hideWindow(): Promise<void>;
  quit(): Promise<void>;
  /** Subscribe to inbound tel: URLs delivered by the OS. Returns unsubscribe. */
  onTelUrl(cb: (number: string) => void): () => void;
  /** Pull any tel: URL that arrived before the renderer subscribed. */
  consumePendingTel(): Promise<string | null>;
}

declare global {
  interface Window {
    cti: CtiBridge;
  }
}
