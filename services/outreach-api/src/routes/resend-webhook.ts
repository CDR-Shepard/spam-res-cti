/**
 * POST /api/webhooks/resend: Resend's (Svix's) delivery and inbound events. The first PUBLIC route under /api
 * (no session: the signature is the credential), so it is deliberately small:
 *
 *  - It verifies, stores and answers. Nothing is processed here; the events tick (email/events.ts) works
 *    through the stored rows, so Resend gets its 200 at once and a slow tick never makes it retry.
 *  - The signature is over the body's exact bytes, so this plugin (and only this one: Fastify scopes a
 *    content-type parser to its plugin) reads `application/json` as a raw string with a 256 KB limit, and
 *    nothing is parsed before it is verified. Any other content type is Fastify's 415.
 *  - Dedupe is the table's primary key: a redelivery, or an in-window replay of a captured request, hits
 *    `on conflict (svix_id) do nothing` and answers 200 without storing or resetting anything.
 *  - Only the STORED copy is cleaned of U+0000 (in every string and key): Postgres jsonb refuses it, and an
 *    inbound email whose subject carried one would otherwise be a 500 that Svix retries for days. The
 *    signature was already checked over the raw body, so the cleaning cannot change what was verified.
 *  - Each svix header must be exactly one string; Fastify types a header as `string | string[]`, and an
 *    array is refused rather than guessed at. A 401 never says which part was wrong.
 *
 * Logs carry the request id only: never a header, the signature, or any field of the body.
 */
import type { FastifyInstance } from 'fastify';
import { schema, type Db } from '@cti/db';
import { sendError } from '../http/errors.js';
import { verifyWebhookSignature } from '../email/webhook-signature.js';

/** Resend's events are a few KB; this bounds what an unauthenticated caller can make us read. */
export const WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024;

export interface ResendWebhookDeps {
  db: Db;
  /** `RESEND_WEBHOOK_SECRET`; null when email is not configured (the route answers 503). */
  secret: string | null;
  now?: () => Date;
}

/** One header as a single non-empty string, or null (missing, empty or repeated). */
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * A copy of parsed JSON with every U+0000 removed from every string, object keys included. Built with
 * `Object.fromEntries`, which defines own properties, so a `__proto__` key stays data and never becomes the
 * copy's prototype.
 */
function withoutNul(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\u0000', '');
  if (Array.isArray(value)) return value.map(withoutNul);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key.replaceAll('\u0000', ''), withoutNul(inner)]));
  }
  return value;
}

/** The stored shape of an event: an object with a type. Anything else is not something the tick could process. */
function parseEvent(body: string): { type: string; payload: Record<string, unknown> } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const payload = withoutNul(parsed) as Record<string, unknown>;
  return typeof payload.type === 'string' && payload.type.trim() !== '' ? { type: payload.type, payload } : null;
}

export async function registerResendWebhookRoutes(app: FastifyInstance, deps: ResendWebhookDeps): Promise<void> {
  // Replaces Fastify's JSON parser and drops its text/plain one, inside this plugin only.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: WEBHOOK_BODY_LIMIT_BYTES }, (_req, body, done) => done(null, body));

  app.post('/webhooks/resend', async (req, reply) => {
    if (deps.secret === null) return sendError(reply, 503, 'EMAIL_NOT_CONFIGURED', 'Email is not set up on this server.');

    const id = single(req.headers['svix-id']);
    const timestamp = single(req.headers['svix-timestamp']);
    const signature = single(req.headers['svix-signature']);
    const body = req.body;
    if (
      id === null ||
      timestamp === null ||
      signature === null ||
      typeof body !== 'string' ||
      !verifyWebhookSignature({ secret: deps.secret, id, timestamp, signature, body, now: deps.now?.() ?? new Date() })
    ) {
      req.log.warn({ requestId: req.id }, 'resend webhook rejected: not signed');
      return sendError(reply, 401, 'BAD_SIGNATURE', 'The webhook signature is not valid.');
    }

    const event = parseEvent(body);
    if (!event) return sendError(reply, 400, 'BAD_REQUEST', 'The webhook body is not a Resend event.');

    await deps.db
      .insert(schema.resendWebhookEvents)
      .values({ svixId: id, type: event.type, payload: event.payload })
      .onConflictDoNothing({ target: schema.resendWebhookEvents.svixId });
    return { ok: true };
  });
}
