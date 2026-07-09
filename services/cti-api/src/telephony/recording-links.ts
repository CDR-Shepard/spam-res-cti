/**
 * Public, no-login recording playback links.
 *
 * Call recordings live in Twilio behind HTTP Basic auth, so a raw Twilio media
 * URL can't be handed to "anyone with the link". Instead we expose a proxy
 * endpoint (`GET /recordings/:callId`) that streams the audio using our
 * server-side Twilio credentials. To stop anyone from enumerating other calls'
 * recordings, each link carries an unguessable signature bound to the call id:
 * a truncated HMAC-SHA256(callId) keyed by SESSION_SECRET. Stateless (no
 * per-recording token column) yet unforgeable without the server secret.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** 128-bit truncated HMAC → 32 hex chars. Ample against guessing. */
const SIG_HEX_LEN = 32;
const SIG_RE = /^[0-9a-f]{32}$/i;

export function signRecordingId(callId: string, secret: string): string {
  return createHmac('sha256', secret).update(callId).digest('hex').slice(0, SIG_HEX_LEN);
}

/** Constant-time verification. Rejects malformed input before comparing. */
export function verifyRecordingSig(callId: string, sig: string, secret: string): boolean {
  if (typeof sig !== 'string' || !SIG_RE.test(sig)) return false;
  const expected = signRecordingId(callId, secret);
  const a = Buffer.from(sig.toLowerCase(), 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export interface RecordingLinkConfig {
  apiPublicUrl: string;
  secret: string;
}

/**
 * The public URL that gets written into Salesforce and can be played by anyone
 * with the link — no Twilio or Salesforce login required.
 */
export function buildRecordingPublicUrl(callId: string, cfg: RecordingLinkConfig): string {
  const sig = signRecordingId(callId, cfg.secret);
  return `${cfg.apiPublicUrl}/recordings/${callId}?sig=${sig}`;
}
