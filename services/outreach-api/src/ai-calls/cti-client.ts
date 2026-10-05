/**
 * outreach-api's side of the internal AI call trigger (plan 1C): signed, short-timeout, and it
 * never throws. A transport outcome (timeout, network, a non-200, an unreadable body) is
 * something the pacer retries with the SAME idempotency key, so cti-api can never place a
 * second call for one touch attempt.
 */
import { internalRequestHeaders } from '@cti/auth';
import {
  AiAvailability,
  INTERNAL_AI_AVAILABILITY_PATH,
  INTERNAL_AI_CALLS_PATH,
  InternalAiCallResponse,
  type InternalAiCallRequest,
} from '@cti/contracts';

export const TRIGGER_TIMEOUT_MS = 20_000;

export type TriggerOutcome = { kind: 'response'; response: InternalAiCallResponse } | { kind: 'transport'; error: string };

export interface CtiClient {
  trigger(req: InternalAiCallRequest): Promise<TriggerOutcome>;
  availability(): Promise<AiAvailability | null>;
}

const errorName = (err: unknown): string => (err instanceof Error || err instanceof DOMException ? err.name : '');

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
        const name = errorName(err);
        return { kind: 'transport', error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network' };
      }
      const json: unknown = await res.json().catch(() => null);
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
  };
}
