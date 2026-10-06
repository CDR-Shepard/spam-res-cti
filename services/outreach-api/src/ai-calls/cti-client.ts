/**
 * outreach-api's side of the internal AI call trigger (plan 1C): signed, short-timeout, and it
 * never throws. A transport outcome (timeout, network, a non-200, an unreadable body) is
 * something the pacer retries with the SAME idempotency key, so cti-api can never place a
 * second call for one touch attempt. A 409 is not transport (M-3): cti-api already holds or
 * answered that key for a different request, so the same key can only meet 409 again.
 *
 * Plan 1E: `browserToken` relays an admin's incoming-only Voice token for "Talk in browser". It never throws and never
 * logs: the token is only ever handed back to the caller.
 */
import { internalRequestHeaders } from '@cti/auth';
import {
  AiAvailability,
  INTERNAL_AI_AVAILABILITY_PATH,
  INTERNAL_AI_BROWSER_TOKEN_PATH,
  INTERNAL_AI_CALLS_PATH,
  InternalAiCallResponse,
  InternalBrowserTokenResponse,
  type InternalAiCallRequest,
  type InternalBrowserTokenRequest,
} from '@cti/contracts';

export const TRIGGER_TIMEOUT_MS = 20_000;

export type TriggerOutcome =
  | { kind: 'response'; response: InternalAiCallResponse }
  | { kind: 'transport'; error: string }
  /** HTTP 409 idempotency_conflict: the key is cti-api's already, for a different body. The pacer asks cti-api's request store what happened under it before it ever mints a new key. */
  | { kind: 'conflict' };

/** cti-api's refusals of a browser token, by the `error` code in its body. */
const TOKEN_REFUSALS = ['not_admin', 'unknown_user', 'browser_calls_unavailable'] as const;
type TokenRefusal = (typeof TOKEN_REFUSALS)[number];

export type BrowserTokenOutcome =
  | { kind: 'token'; token: string; identity: string; expiresAt: string }
  | { kind: 'refused'; code: TokenRefusal }
  | { kind: 'transport'; error: string };

export interface CtiClient {
  trigger(req: InternalAiCallRequest): Promise<TriggerOutcome>;
  availability(): Promise<AiAvailability | null>;
  /** Never throws; never logs the token. */
  browserToken(req: InternalBrowserTokenRequest): Promise<BrowserTokenOutcome>;
}

const errorName = (err: unknown): string => (err instanceof Error || err instanceof DOMException ? err.name : '');
const transportError = (err: unknown): string => (errorName(err) === 'TimeoutError' || errorName(err) === 'AbortError' ? 'timeout' : 'network');
const tokenRefusal = (json: unknown): TokenRefusal | null => {
  const code = (json as { error?: unknown } | null)?.error;
  return (TOKEN_REFUSALS as readonly unknown[]).includes(code) ? (code as TokenRefusal) : null;
};

/** The `error` code cti-api put in a refusal's body, if it is a short string. */
function bodyError(json: unknown): string {
  const code = (json as { error?: unknown } | null)?.error;
  return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? ` ${code}` : '';
}

export function httpCtiClient(cfg: { CTI_INTERNAL_URL: string; OUTREACH_INTERNAL_SECRET: string }, fetchImpl: typeof fetch = fetch): CtiClient {
  const base = cfg.CTI_INTERNAL_URL.replace(/\/+$/, '');
  const send = (method: 'GET' | 'POST', path: string, body: string): Promise<Response> =>
    fetchImpl(`${base}${path}`, {
      method,
      headers: {
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...internalRequestHeaders(cfg.OUTREACH_INTERNAL_SECRET, { method, path, body }),
      },
      ...(method === 'POST' ? { body } : {}),
      signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
    });

  return {
    async trigger(req) {
      let res: Response;
      try {
        res = await send('POST', INTERNAL_AI_CALLS_PATH, JSON.stringify(req));
      } catch (err) {
        return { kind: 'transport', error: transportError(err) };
      }
      const json: unknown = await res.json().catch(() => null);
      if (res.status === 409) return { kind: 'conflict' };
      if (res.status !== 200) return { kind: 'transport', error: `HTTP ${res.status}${bodyError(json)}` };
      const parsed = InternalAiCallResponse.safeParse(json);
      return parsed.success ? { kind: 'response', response: parsed.data } : { kind: 'transport', error: 'bad_response' };
    },
    async availability() {
      try {
        const res = await send('GET', INTERNAL_AI_AVAILABILITY_PATH, '');
        if (res.status !== 200) return null;
        const parsed = AiAvailability.safeParse(await res.json());
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    async browserToken(req) {
      let res: Response;
      try {
        res = await send('POST', INTERNAL_AI_BROWSER_TOKEN_PATH, JSON.stringify(req));
      } catch (err) {
        return { kind: 'transport', error: transportError(err) };
      }
      const json: unknown = await res.json().catch(() => null);
      const refused = res.status === 403 || res.status === 503 ? tokenRefusal(json) : null;
      if (refused) return { kind: 'refused', code: refused };
      if (res.status !== 200) return { kind: 'transport', error: `HTTP ${res.status}${bodyError(json)}` };
      const parsed = InternalBrowserTokenResponse.safeParse(json);
      return parsed.success ? { kind: 'token', ...parsed.data } : { kind: 'transport', error: 'bad_response' };
    },
  };
}
