import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

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
const b64u = (buf: Buffer): string => buf.toString('base64url');
const hmac = (secret: string, data: string): string => b64u(createHmac('sha256', secret).update(data).digest());
/**
 * Same-origin relative path only: one leading slash (never "//" or "/\" —
 * both are browser host-confusion tricks), and no backslash, space, or ASCII
 * control character anywhere else in the path (blocks further host-confusion
 * and header/URL-injection tricks in the eventual redirect target).
 */
const SAFE_RETURN_TO = /^\/(?![\/\\])[^\\\x00-\x20]*$/;
export function isSafeReturnTo(value: string): boolean {
  return SAFE_RETURN_TO.test(value);
}
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
