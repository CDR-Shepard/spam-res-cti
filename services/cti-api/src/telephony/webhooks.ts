/**
 * Shared Twilio webhook validation helpers.
 *
 * Twilio signs the EXACT URL it was configured to call — including any query
 * string (e.g. `?callDbId=…`). Validating against a path with the query string
 * stripped can never match a genuine signature, so every real callback 403s.
 * Always rebuild the signed URL from the live request.
 */
import type { FastifyRequest } from 'fastify';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TWILIO_CALL_SID_RE = /^CA[a-f0-9]{32}$/i;
/** Fully anchored, host-pinned, charset-restricted — used at both store and fetch time. */
export const TWILIO_RECORDING_MEDIA_RE = /^https:\/\/api\.twilio\.com\/[A-Za-z0-9/_.-]+$/;

/**
 * The exact public URL Twilio signed = API_PUBLIC_URL + the request path AND
 * query string. `req.url` is `/path?query`; API_PUBLIC_URL has no trailing slash.
 */
export function signedCallbackUrl(apiPublicUrl: string, req: FastifyRequest): string {
  return `${apiPublicUrl}${req.url}`;
}
