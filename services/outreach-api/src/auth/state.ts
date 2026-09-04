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

/** Stateless CSRF token for the OAuth round trip: signed JSON with a 10-minute life. */
export function signState(secret: string, input: { returnTo?: string }, now: number = Date.now()): string {
  const body: StatePayload = { nonce: b64u(randomBytes(16)), iat: Math.floor(now / 1000) };
  if (input.returnTo) body.returnTo = input.returnTo;
  const enc = b64u(Buffer.from(JSON.stringify(body), 'utf8'));
  return `${enc}.${hmac(secret, enc)}`;
}

export function verifyState(secret: string, state: string, now: number = Date.now()): StatePayload | null {
  const [enc, sig] = state.split('.');
  if (!enc || !sig) return null;
  const expected = Buffer.from(hmac(secret, enc));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let body: Partial<StatePayload>;
  try {
    body = JSON.parse(Buffer.from(enc, 'base64url').toString('utf8')) as Partial<StatePayload>;
  } catch {
    return null;
  }
  if (typeof body.nonce !== 'string' || typeof body.iat !== 'number') return null;
  const age = Math.floor(now / 1000) - body.iat;
  if (age < 0 || age > STATE_TTL_SECONDS) return null;
  if (body.returnTo !== undefined && !SAFE_RETURN_TO.test(body.returnTo)) return null;
  return body as StatePayload;
}
