import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isSafeReturnTo } from '@cti/contracts';

export interface StatePayload {
  nonce: string;
  iat: number;
  returnTo?: string;
}
export interface SignedState {
  /** The opaque, HMAC-signed token to round-trip through the provider as `state`. */
  state: string;
  /**
   * The same nonce embedded in `state`, exposed so the caller can bind it to a
   * short-lived cookie set at the start of the flow: the callback then requires
   * that cookie to carry this same nonce (login-CSRF defense — the browser that
   * completes the callback must be the one that started it, not merely someone
   * holding a validly signed `state`).
   */
  nonce: string;
}
export const STATE_TTL_SECONDS = 600;
/**
 * Domain separation: `SESSION_SECRET` also keys `@fastify/cookie`'s signer
 * (app.ts), whose `value.hmac` wire shape is the same as this token's. Signing
 * with a purpose-derived subkey instead of the raw secret means a state token
 * can never validate as a signed cookie (or vice versa), and the same recipe
 * gives any later HMAC use of the secret (plan 3's webhook signature) its own
 * key. Bump the version if the payload format ever changes.
 */
export const STATE_KEY_PURPOSE = 'outreach:oauth-state:v1';
export function deriveStateKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(STATE_KEY_PURPOSE).digest();
}
const b64u = (buf: Buffer): string => buf.toString('base64url');
const hmac = (secret: string, data: string): string => b64u(createHmac('sha256', deriveStateKey(secret)).update(data).digest());
// The same-origin-only `returnTo` rule is shared with outreach-web's route
// `validateSearch` (both must accept/reject exactly the same paths), so it
// lives once in @cti/contracts. Re-exported here (rather than only imported)
// because state.test.ts and routes/auth.ts both import `isSafeReturnTo` from
// this module, not from @cti/contracts directly.
export { isSafeReturnTo };
/** Small grace window for clock skew between the process that signed and the one verifying. */
const CLOCK_SKEW_SECONDS = 2;

/** Stateless CSRF token for the OAuth round trip: signed JSON with a 10-minute life. */
export function signState(secret: string, input: { returnTo?: string }, now: number = Date.now()): SignedState {
  const nonce = b64u(randomBytes(16));
  const body: StatePayload = { nonce, iat: Math.floor(now / 1000) };
  if (input.returnTo) body.returnTo = input.returnTo;
  const enc = b64u(Buffer.from(JSON.stringify(body), 'utf8'));
  return { state: `${enc}.${hmac(secret, enc)}`, nonce };
}

export function verifyState(secret: string, state: string, now: number = Date.now()): StatePayload | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [enc, sig] = parts;
  if (!enc || !sig) return null;
  const expected = Buffer.from(hmac(secret, enc));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(enc, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const body = parsed as Partial<StatePayload>;
  if (typeof body.nonce !== 'string' || typeof body.iat !== 'number') return null;
  const age = Math.floor(now / 1000) - body.iat;
  if (age < -CLOCK_SKEW_SECONDS || age > STATE_TTL_SECONDS) return null;
  if (body.returnTo !== undefined && !isSafeReturnTo(body.returnTo)) return null;
  return body as StatePayload;
}
