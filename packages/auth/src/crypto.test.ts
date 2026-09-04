import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  constantTimeEquals,
  decryptString,
  encryptString,
  pkceChallenge,
  randomToken,
  sha256,
} from './crypto.js';

const KEY = 'ab'.repeat(32);

beforeEach(() => vi.stubEnv('TOKEN_ENCRYPTION_KEY', KEY));
afterEach(() => vi.unstubAllEnvs());

describe('encryptString / decryptString', () => {
  it('round-trips utf8 text', () => {
    expect(decryptString(encryptString('refresh-token-ü'))).toBe('refresh-token-ü');
  });

  it('emits a v1 envelope with a fresh IV per call', () => {
    const a = encryptString('same');
    const b = encryptString('same');
    expect(a.split(':')).toHaveLength(4);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a).not.toBe(b);
  });

  it('rejects tampered ciphertext', () => {
    const parts = encryptString('secret').split(':');
    parts[2] = Buffer.from('tampered-bytes').toString('base64');
    expect(() => decryptString(parts.join(':'))).toThrow();
  });

  it('rejects a malformed envelope', () => {
    expect(() => decryptString('not-an-envelope')).toThrow('Invalid ciphertext envelope');
  });

  it('fails loudly when the key is missing or malformed', () => {
    vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'short');
    expect(() => encryptString('x')).toThrow('TOKEN_ENCRYPTION_KEY must be 64 hex chars');
  });
});

describe('helpers', () => {
  it('sha256 matches the known vector for "abc"', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('randomToken is base64url with no padding', () => {
    const t = randomToken(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(42);
  });

  it('constantTimeEquals compares equal and unequal strings', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'ab')).toBe(false);
  });

  it('pkceChallenge matches RFC 7636 appendix B', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});
