/**
 * Service-to-service request signing (outreach-api → cti-api over Railway private networking).
 * HMAC-SHA256 over the method, path, timestamp and body hash; a timestamp outside ±5 minutes is
 * refused, and the receiver's idempotency table (ai_call_requests) makes a replay inside the
 * window return the stored answer instead of acting twice.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const INTERNAL_TIMESTAMP_HEADER = 'x-outreach-timestamp';
export const INTERNAL_SIGNATURE_HEADER = 'x-outreach-signature';
export const INTERNAL_MAX_SKEW_MS = 5 * 60_000;
export const INTERNAL_SECRET_MIN_LENGTH = 32;

export interface InternalRequestParts {
  method: string;
  /** The request URL path, including any query string. */
  path: string;
  /** The raw request body, byte for byte ('' for none). */
  body: string;
}

export type InternalVerdict = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' };

/** A misconfigured (short or empty) secret must never sign or verify anything. */
function assertSecret(secret: string): void {
  if (secret.length < INTERNAL_SECRET_MIN_LENGTH) {
    throw new Error(`internal secret must be at least ${INTERNAL_SECRET_MIN_LENGTH} characters`);
  }
}

/** `v1=<hex>`: HMAC-SHA256 of `v1\n<METHOD>\n<path>\n<timestamp>\n<sha256 hex of the body>`. */
export function signInternalRequest(secret: string, parts: InternalRequestParts, timestamp: string): string {
  assertSecret(secret);
  const bodyHash = createHash('sha256').update(parts.body, 'utf8').digest('hex');
  const message = ['v1', parts.method.toUpperCase(), parts.path, timestamp, bodyHash].join('\n');
  return `v1=${createHmac('sha256', secret).update(message, 'utf8').digest('hex')}`;
}

/** The two headers a signed request carries; the timestamp is Unix seconds. */
export function internalRequestHeaders(secret: string, parts: InternalRequestParts, now: Date = new Date()): Record<string, string> {
  const timestamp = String(Math.floor(now.getTime() / 1000));
  return { [INTERNAL_TIMESTAMP_HEADER]: timestamp, [INTERNAL_SIGNATURE_HEADER]: signInternalRequest(secret, parts, timestamp) };
}

export function verifyInternalRequest(
  secret: string,
  parts: InternalRequestParts,
  headers: { timestamp: string | undefined; signature: string | undefined },
  now: Date = new Date(),
): InternalVerdict {
  assertSecret(secret);
  const { timestamp, signature } = headers;
  if (!timestamp || !signature) return { ok: false, reason: 'missing' };
  if (!/^\d{1,12}$/.test(timestamp) || !/^v1=[0-9a-f]{64}$/.test(signature)) return { ok: false, reason: 'malformed' };
  if (Math.abs(now.getTime() - Number(timestamp) * 1000) > INTERNAL_MAX_SKEW_MS) return { ok: false, reason: 'stale' };
  const expected = Buffer.from(signInternalRequest(secret, parts, timestamp), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given) ? { ok: true } : { ok: false, reason: 'mismatch' };
}
