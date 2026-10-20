/**
 * Verifies a Resend webhook, which is Svix-signed.
 *
 * Svix sends three headers: `svix-id`, `svix-timestamp` (unix seconds) and `svix-signature`, a
 * space-separated list of `v1,<base64>` entries (a rotated secret signs with both the old and the
 * new key, so any one entry may match). The signed content is `${id}.${timestamp}.${rawBody}`; the
 * key is the base64 decoding of the secret after its `whsec_` prefix; the signature is HMAC-SHA256,
 * base64.
 *
 * The body must be the exact bytes Resend sent: a parsed-then-reserialised body can differ by one
 * space and fail. Pure and total: no I/O, no logging, and a malformed header, timestamp or secret
 * is `false`, never a throw (the route answers 401 either way, and says nothing about which part
 * was wrong). Total includes what the types promise but the runtime does not keep: every input is
 * checked to be what it claims (a header Fastify hands over as an array, an `undefined` that
 * stringifies into a plausible id), and a window that cannot be measured is closed, not open.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far the signed timestamp may be from now, either way: replay protection against a captured request. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const SECRET_PREFIX = 'whsec_';
/** Svix's own secrets decode to 24 bytes or more; under 16 is a typo or a truncated paste, and HMAC would accept it all the same. */
const MIN_KEY_BYTES = 16;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Unix seconds as Svix sends them: digits only, so `1e9`, ` 17…`, `17.5` and `-17` are not timestamps. */
const TIMESTAMP = /^\d{1,12}$/;

export interface WebhookSignatureInput {
  /** `RESEND_WEBHOOK_SECRET`: `whsec_` + base64. */
  secret: string;
  /** The `svix-id` header. */
  id: string;
  /** The `svix-timestamp` header (unix seconds). */
  timestamp: string;
  /** The `svix-signature` header. */
  signature: string;
  /** The raw request body, byte for byte. */
  body: string;
  now: Date;
}

/** The key bytes inside a `whsec_` secret, or null when it is not one (an unusable secret fails closed). */
function signingKey(secret: string): Buffer | null {
  if (!secret.startsWith(SECRET_PREFIX)) return null;
  const encoded = secret.slice(SECRET_PREFIX.length);
  if (!BASE64.test(encoded)) return null;
  const key = Buffer.from(encoded, 'base64');
  return key.length >= MIN_KEY_BYTES ? key : null;
}

export function verifyWebhookSignature(i: WebhookSignatureInput): boolean {
  if (![i.secret, i.id, i.timestamp, i.signature, i.body].every((v) => typeof v === 'string')) return false;
  if (!(i.now instanceof Date) || !TIMESTAMP.test(i.timestamp)) return false;
  // Written as "not within" so an unmeasurable window is refused: with an invalid `now` (NaN) both `> 300` and `<= 300` are false, so only this form fails closed.
  if (!(Math.abs(i.now.getTime() / 1000 - Number(i.timestamp)) <= WEBHOOK_TOLERANCE_SECONDS)) return false;
  const key = signingKey(i.secret);
  if (!key) return false;

  // Compared as the base64 text that travels in the header, not as decoded bytes: Node's base64 decoder is lenient, so a
  // final character that differs only in its padding bits would decode to the same bytes and pass.
  const expected = Buffer.from(createHmac('sha256', key).update(`${i.id}.${i.timestamp}.${i.body}`).digest('base64'));
  let matched = false;
  for (const entry of i.signature.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma === -1 || entry.slice(0, comma) !== 'v1') continue;
    const candidate = Buffer.from(entry.slice(comma + 1));
    // timingSafeEqual throws on unequal lengths, and a length is not a secret: compare only equal-length buffers.
    // No early return: every v1 entry is compared, so timing does not reveal which one matched.
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) matched = true;
  }
  return matched;
}
