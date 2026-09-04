import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface StatePayload {
  nonce: string;
  iat: number;
  returnTo?: string;
}
export const STATE_TTL_SECONDS = 600;
const b64u = (buf: Buffer): string => buf.toString('base64url');
const hmac = (secret: string, data: string): string => b64u(createHmac('sha256', secret).update(data).digest());
/** Same-origin relative path only: starts with one slash, never two. */
const SAFE_RETURN_TO = /^\/(?!\/)/;
/** Small grace window for clock skew between the process that signed and the one verifying. */
const CLOCK_SKEW_SECONDS = 2;

/** Stateless CSRF token for the OAuth round trip: signed JSON with a 10-minute life. */
export function signState(secret: string, input: { returnTo?: string }, now: number = Date.now()): string {
  const body: StatePayload = { nonce: b64u(randomBytes(16)), iat: Math.floor(now / 1000) };
  if (input.returnTo) body.returnTo = input.returnTo;
  const enc = b64u(Buffer.from(JSON.stringify(body), 'utf8'));
  return `${enc}.${hmac(secret, enc)}`;
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
  if (body.returnTo !== undefined && !SAFE_RETURN_TO.test(body.returnTo)) return null;
  return body as StatePayload;
}
