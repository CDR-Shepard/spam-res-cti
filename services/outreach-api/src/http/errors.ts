import type { errorResponseBuilderContext } from '@fastify/rate-limit';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** The one error envelope every route sends (see @cti/contracts ApiError). */
export function sendError(reply: FastifyReply, status: number, code: string, error: string, details?: unknown): FastifyReply {
  const body: Record<string, unknown> = { error, code, requestId: reply.request.id };
  if (details !== undefined) body.details = details;
  return reply.code(status).send(body);
}

export const INTERNAL_ERROR_MESSAGE = 'Something went wrong on our side. Try again in a minute.';

/** Stable client-facing codes for the 4xx statuses Fastify and its plugins raise on their own. */
const CLIENT_ERROR_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  406: 'NOT_ACCEPTABLE',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
};

function statusOf(err: FastifyError): number {
  const s = err.statusCode;
  return typeof s === 'number' && s >= 400 && s <= 599 ? s : 500;
}

/**
 * Every error a route does not catch itself ends up here, in the `ApiError`
 * envelope: 4xx raised by Fastify or a plugin keep their (safe, Fastify-authored)
 * message under a stable code — schema failures as 400 `VALIDATION_FAILED` —
 * while anything 5xx becomes 500 `INTERNAL_ERROR` with a generic message. The
 * real error (message and stack) is logged server-side with the request id so
 * it can be found; it never reaches the browser (spec §11). 404s are not
 * errors and stay with the not-found handler (routes/spa.ts).
 */
export function handleRequestError(err: FastifyError, req: FastifyRequest, reply: FastifyReply): FastifyReply {
  const status = statusOf(err);
  if (status >= 500) {
    req.log.error({ err, requestId: req.id }, 'unhandled request error');
    return sendError(reply, 500, 'INTERNAL_ERROR', INTERNAL_ERROR_MESSAGE);
  }
  if (err.validation) return sendError(reply, 400, 'VALIDATION_FAILED', err.message);
  req.log.info({ err: err.message, code: err.code, status, requestId: req.id }, 'request rejected');
  return sendError(reply, status, CLIENT_ERROR_CODES[status] ?? 'BAD_REQUEST', err.message);
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(handleRequestError);
}

/**
 * `@fastify/rate-limit` *throws* whatever its `errorResponseBuilder` returns,
 * so this shapes an error that `handleRequestError` maps to the envelope
 * (429 → `RATE_LIMITED`, or 403 when a ban is configured) instead of Fastify's
 * default `{ statusCode, error, message }` body.
 */
export function rateLimitError(_req: FastifyRequest, context: errorResponseBuilderContext): Error {
  return Object.assign(new Error(`Too many requests. Try again in ${context.after}.`), { statusCode: context.ban ? 403 : 429 });
}
