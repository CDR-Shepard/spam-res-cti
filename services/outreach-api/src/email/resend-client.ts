/**
 * outreach-api's side of Resend: send one email, and read one inbound email back.
 *
 * `send` never throws. Every outcome is one of three, and the caller (the email worker) keeps its own
 * state around them:
 *   - `sent`: Resend accepted it (HTTP 200 and an id).
 *   - `retry`: nothing is known to have gone wrong permanently (429, 5xx, a concurrent request on the
 *     same idempotency key, a timeout, a dropped connection, an answer we could not read). Sending
 *     again with the SAME idempotency key is safe: Resend answers a repeat from the first attempt
 *     for 24 hours, so a retry can never deliver a second copy.
 *   - `rejected`: Resend refused this email (any other 4xx: a bad address, a bad key, a key reused
 *     with a different body). Sending it again would be refused again.
 *
 * `reason` is `HTTP <status> <resend error name>`, `timeout` or `network`, and nothing else: the name
 * is kept only if it is `[a-z_]+`, and the message, the body, the address, the text and the
 * API key are never read into an outcome or an error. Seller data is PII, so a reason is safe to log.
 *
 * `getReceived` reads an inbound email by id (Resend's webhook carries only the id). It throws
 * `ResendError` on anything but a readable 200, again with a reason and no body.
 */
import { z } from 'zod';

const RESEND_API = 'https://api.resend.com';
export const RESEND_TIMEOUT_MS = 15_000;

export interface ResendSendRequest {
  /** `Name <address>`: the From header. */
  from: string;
  /** One recipient: Sam writes to one seller at a time. */
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The conversation's own reply mailbox (`sam+<token>@<reply domain>`). */
  replyTo: string;
  /** Extra headers, e.g. List-Unsubscribe. */
  headers: Record<string, string>;
}

export type ResendSendResult = { kind: 'sent'; id: string } | { kind: 'retry'; reason: string } | { kind: 'rejected'; reason: string };

export interface ReceivedEmail {
  id: string;
  /** The From header as sent, display name and all: parse it with addresses.ts parseMailbox. */
  from: string;
  to: string[];
  cc: string[];
  /** The recipients Resend delivered this copy for: where the conversation token is read from. */
  receivedFor: string[];
  subject: string;
  text: string | null;
  html: string | null;
  /** Header names lowercased; values coerced to strings. */
  headers: Record<string, string>;
  messageId: string | null;
}

export interface ResendClient {
  send(req: ResendSendRequest, idempotencyKey: string): Promise<ResendSendResult>;
  getReceived(emailId: string): Promise<ReceivedEmail>;
}

/**
 * Thrown by `getReceived`. `status` is the HTTP status, or 0 when there was no answer (a timeout or a network
 * failure); `message` is the same safe reason `send` reports. Nothing from the response or the request is in it.
 */
export class ResendError extends Error {
  constructor(
    readonly status: number,
    reason: string = `HTTP ${status}`,
  ) {
    super(reason);
    this.name = 'ResendError';
  }
}

const errorName = (err: unknown): string => (err instanceof Error || err instanceof DOMException ? err.name : '');
const transportReason = (err: unknown): 'timeout' | 'network' => (errorName(err) === 'TimeoutError' || errorName(err) === 'AbortError' ? 'timeout' : 'network');

/** The error name in a Resend error body (`validation_error`), only if it is a short `[a-z_]+`: nothing else of a body is ever read. */
function resendErrorName(json: unknown): string | null {
  const name = (json as { name?: unknown } | null)?.name;
  return typeof name === 'string' && /^[a-z_]{1,64}$/.test(name) ? name : null;
}

/** `HTTP <status>`, then the error name when there is one. */
const httpReason = (status: number, name: string | null): string => (name ? `HTTP ${status} ${name}` : `HTTP ${status}`);

/** The 409 that only means "the first attempt on this key is still in flight": the same key answers once it is done. */
const IN_FLIGHT = 'concurrent_idempotent_requests';

const stringList = z
  .array(z.unknown())
  .nullish()
  .transform((v) => (v ?? []).filter((x): x is string => typeof x === 'string'));
const optionalText = z
  .string()
  .nullish()
  .transform((v) => v ?? null);

/** Header values arrive as strings, but a number, a boolean or a list of them is read rather than refused. */
function headerValue(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    const parts = v.map(headerValue).filter((p): p is string => p !== null);
    return parts.length > 0 ? parts.join(', ') : null;
  }
  return null;
}

/** Lowercased names; of two names that differ only in case the first wins. */
function lowercaseHeaders(raw: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    const key = name.toLowerCase();
    const text = headerValue(value);
    if (text !== null && !(key in out)) out[key] = text;
  }
  return out;
}

/** GET /emails/receiving/{id}: unknown keys are ignored and every field but the id has a fallback. */
const receivedSchema = z
  .object({
    id: z.string().min(1),
    from: z.string().nullish().transform((v) => v ?? ''),
    to: stringList,
    cc: stringList,
    received_for: stringList,
    subject: z.string().nullish().transform((v) => v ?? ''),
    text: optionalText,
    html: optionalText,
    headers: z.record(z.string(), z.unknown()).nullish().transform(lowercaseHeaders),
    message_id: z
      .string()
      .nullish()
      .transform((v) => (v ? v : null)),
  })
  .transform(
    (e): ReceivedEmail => ({
      id: e.id,
      from: e.from,
      to: e.to,
      cc: e.cc,
      receivedFor: e.received_for,
      subject: e.subject,
      text: e.text,
      html: e.html,
      headers: e.headers,
      messageId: e.message_id,
    }),
  );

export function httpResendClient(i: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }): ResendClient {
  const fetchImpl = i.fetchImpl ?? fetch;
  const timeoutMs = i.timeoutMs ?? RESEND_TIMEOUT_MS;
  const request = (method: 'GET' | 'POST', path: string, extra: { headers?: Record<string, string>; body?: string } = {}): Promise<Response> =>
    fetchImpl(`${RESEND_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${i.apiKey}`, ...extra.headers },
      ...(extra.body === undefined ? {} : { body: extra.body }),
      signal: AbortSignal.timeout(timeoutMs),
    });

  return {
    async send(req, idempotencyKey) {
      const body = JSON.stringify({
        from: req.from,
        to: [req.to],
        subject: req.subject,
        text: req.text,
        html: req.html,
        reply_to: req.replyTo,
        headers: req.headers,
      });
      let res: Response;
      try {
        res = await request('POST', '/emails', { headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body });
      } catch (err) {
        return { kind: 'retry', reason: transportReason(err) };
      }
      const json: unknown = await res.json().catch(() => null);
      if (res.status === 200) {
        const id = (json as { id?: unknown } | null)?.id;
        // An unreadable 200 is not known to be a failure: the idempotency key makes the repeat safe.
        return typeof id === 'string' && id !== '' ? { kind: 'sent', id } : { kind: 'retry', reason: 'HTTP 200 bad_response' };
      }
      const name = resendErrorName(json);
      const reason = httpReason(res.status, name);
      const inFlight = res.status === 409 && name === IN_FLIGHT;
      // Anything outside 4xx and 5xx that is not a 200 (a stray 2xx or 3xx) is unexpected, not a refusal: try again.
      const refused = res.status >= 400 && res.status < 500 && res.status !== 429 && !inFlight;
      return refused ? { kind: 'rejected', reason } : { kind: 'retry', reason };
    },

    async getReceived(emailId) {
      let res: Response;
      try {
        res = await request('GET', `/emails/receiving/${encodeURIComponent(emailId)}`);
      } catch (err) {
        throw new ResendError(0, transportReason(err));
      }
      const json: unknown = await res.json().catch(() => null);
      if (res.status !== 200) throw new ResendError(res.status, httpReason(res.status, resendErrorName(json)));
      const parsed = receivedSchema.safeParse(json);
      if (!parsed.success) throw new ResendError(200, 'HTTP 200 bad_response');
      return parsed.data;
    },
  };
}
