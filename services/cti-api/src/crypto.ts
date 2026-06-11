import { randomBytes, createCipheriv, createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { loadConfig } from './config.js';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function key(): Buffer {
  return Buffer.from(loadConfig().TOKEN_ENCRYPTION_KEY, 'hex');
}

/**
 * Encrypt to a self-describing string: v1:base64(iv):base64(ciphertext):base64(tag)
 * Used for OAuth refresh/access tokens at rest.
 */
export function encryptString(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${enc.toString('base64')}:${tag.toString('base64')}`;
}

export function decryptString(blob: string): string {
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Invalid ciphertext envelope');
  }
  const iv = Buffer.from(parts[1]!, 'base64');
  const enc = Buffer.from(parts[2]!, 'base64');
  const tag = Buffer.from(parts[3]!, 'base64');
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error('Invalid IV or tag length');
  }
  const decipher = createDecipheriv(ALG, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** PKCE helpers (RFC 7636 S256) */
export function pkceVerifier(): string {
  return base64url(randomBytes(32));
}
export function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}
