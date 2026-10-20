import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WEBHOOK_TOLERANCE_SECONDS, verifyWebhookSignature } from './webhook-signature.js';

// A made-up secret in Svix's shape: `whsec_` + base64 of the key bytes.
const KEY_BYTES = Buffer.from('a-test-signing-key-not-a-real-one');
const SECRET = `whsec_${KEY_BYTES.toString('base64')}`;
const ID = 'msg_2abc';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const BODY = '{"type":"email.received","data":{"email_id":"11111111-2222-3333-4444-555555555555"}}';

const sign = (id: string, timestamp: string, body: string, key: Buffer = KEY_BYTES): string =>
  createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');

const verify = (over: Partial<Parameters<typeof verifyWebhookSignature>[0]> = {}): boolean => {
  const timestamp = over.timestamp ?? String(NOW_SECONDS);
  return verifyWebhookSignature({
    secret: SECRET,
    id: ID,
    timestamp,
    signature: `v1,${sign(ID, timestamp, BODY)}`,
    body: BODY,
    now: NOW,
    ...over,
  });
};

describe('verifyWebhookSignature', () => {
  it('passes a signature computed over `${id}.${timestamp}.${body}` with the decoded secret', () => {
    expect(verify()).toBe(true);
  });

  it('fails when one byte of the body changes', () => {
    expect(verify({ body: BODY.replace('email.received', 'email.receivee') })).toBe(false);
    expect(verify({ body: `${BODY} ` })).toBe(false);
  });

  it('fails when the id or the timestamp the signature covers is not the one sent', () => {
    expect(verify({ id: 'msg_other' })).toBe(false);
    const signedAt = String(NOW_SECONDS - 10);
    expect(verify({ timestamp: String(NOW_SECONDS - 9), signature: `v1,${sign(ID, signedAt, BODY)}` })).toBe(false);
  });

  it('fails when signed with a different secret', () => {
    expect(verify({ signature: `v1,${sign(ID, String(NOW_SECONDS), BODY, Buffer.from('some-other-key'))}` })).toBe(false);
  });

  describe('the five-minute window', () => {
    it('is 300 seconds', () => {
      expect(WEBHOOK_TOLERANCE_SECONDS).toBe(300);
    });
    it('passes at exactly 300 seconds old and fails at 301', () => {
      expect(verify({ timestamp: String(NOW_SECONDS - 300) })).toBe(true);
      expect(verify({ timestamp: String(NOW_SECONDS - 301) })).toBe(false);
    });
    it('treats a timestamp from the future the same way (clock skew is bounded both ways)', () => {
      expect(verify({ timestamp: String(NOW_SECONDS + 300) })).toBe(true);
      expect(verify({ timestamp: String(NOW_SECONDS + 301) })).toBe(false);
    });
    it.each(['', 'abc', '1e9', ' 1792000000', '1792000000.5', '-1792000000', '0x1'])('refuses the timestamp %j without throwing', (timestamp) => {
      expect(verify({ timestamp, signature: `v1,${sign(ID, timestamp, BODY)}` })).toBe(false);
    });
  });

  describe('the signature header', () => {
    const good = (): string => sign(ID, String(NOW_SECONDS), BODY);

    it('passes when any one of several space-separated v1 entries matches', () => {
      expect(verify({ signature: `v1,bad v1,${good()}` })).toBe(true);
      expect(verify({ signature: `v1,${good()} v1,bad` })).toBe(true);
    });
    it('fails when a v2 entry alone carries the good signature', () => {
      expect(verify({ signature: `v2,${good()}` })).toBe(false);
    });
    it('ignores a v2 entry beside a v1 that does not match', () => {
      expect(verify({ signature: `v2,${good()} v1,bad` })).toBe(false);
    });
    it('fails on an empty, unversioned or truncated header', () => {
      expect(verify({ signature: '' })).toBe(false);
      expect(verify({ signature: good() })).toBe(false);
      expect(verify({ signature: 'v1,' })).toBe(false);
      expect(verify({ signature: `v1,${good().slice(0, -4)}` })).toBe(false);
      expect(verify({ signature: `v1,${good()}AAAA` })).toBe(false);
    });
    it('fails on a signature whose last base64 character differs only in its padding bits, though it decodes to the same bytes', () => {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const sig = good();
      const at = sig.length - 2; // the character before the single `=`: four data bits, two padding bits
      const twin = sig.slice(0, at) + alphabet[alphabet.indexOf(sig[at]!) ^ 1] + sig.slice(at + 1);
      expect(twin).not.toBe(sig);
      expect(Buffer.from(twin, 'base64').equals(Buffer.from(sig, 'base64'))).toBe(true); // the premise: a lenient decoder cannot tell them apart
      expect(verify({ signature: `v1,${twin}` })).toBe(false);
    });
    it('tolerates repeated spaces between entries', () => {
      expect(verify({ signature: `v1,bad   v1,${good()}` })).toBe(true);
    });
  });

  describe('the secret', () => {
    it.each(['', 'whsec_', 'no-prefix', 'whsec_!!not base64!!'])('fails closed on the unusable secret %j without throwing', (secret) => {
      expect(verify({ secret })).toBe(false);
    });
  });
});
