import { describe, expect, it } from 'vitest';
import { buildRecordingPublicUrl, signRecordingId, verifyRecordingSig } from './recording-links.js';

const SECRET = 'test-session-secret-at-least-32-characters-long';
const CALL_ID = '11111111-2222-3333-4444-555555555555';

describe('signRecordingId', () => {
  it('is deterministic and 32 lowercase hex chars', () => {
    const a = signRecordingId(CALL_ID, SECRET);
    const b = signRecordingId(CALL_ID, SECRET);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('differs by call id and by secret', () => {
    expect(signRecordingId(CALL_ID, SECRET)).not.toBe(signRecordingId('other-id', SECRET));
    expect(signRecordingId(CALL_ID, SECRET)).not.toBe(signRecordingId(CALL_ID, 'other-secret'));
  });
});

describe('verifyRecordingSig', () => {
  it('accepts a signature it produced', () => {
    const sig = signRecordingId(CALL_ID, SECRET);
    expect(verifyRecordingSig(CALL_ID, sig, SECRET)).toBe(true);
    expect(verifyRecordingSig(CALL_ID, sig.toUpperCase(), SECRET)).toBe(true);
  });

  it('rejects a sig for a different call id (no cross-call enumeration)', () => {
    const sig = signRecordingId(CALL_ID, SECRET);
    expect(verifyRecordingSig('99999999-2222-3333-4444-555555555555', sig, SECRET)).toBe(false);
  });

  it('rejects the wrong secret, tampering, and malformed input', () => {
    const sig = signRecordingId(CALL_ID, SECRET);
    expect(verifyRecordingSig(CALL_ID, sig, 'wrong-secret')).toBe(false);
    expect(verifyRecordingSig(CALL_ID, 'f'.repeat(32), SECRET)).toBe(false);
    expect(verifyRecordingSig(CALL_ID, '', SECRET)).toBe(false);
    expect(verifyRecordingSig(CALL_ID, 'not-hex-!!' + 'a'.repeat(22), SECRET)).toBe(false);
    expect(verifyRecordingSig(CALL_ID, sig + 'ab', SECRET)).toBe(false); // wrong length
    // @ts-expect-error runtime guard for non-string
    expect(verifyRecordingSig(CALL_ID, undefined, SECRET)).toBe(false);
  });
});

describe('buildRecordingPublicUrl', () => {
  it('builds a verifiable proxy URL', () => {
    const url = buildRecordingPublicUrl(CALL_ID, { apiPublicUrl: 'https://api.example.com', secret: SECRET });
    expect(url).toMatch(new RegExp(`^https://api\\.example\\.com/recordings/${CALL_ID}\\?sig=[0-9a-f]{32}$`));
    const sig = new URL(url).searchParams.get('sig')!;
    expect(verifyRecordingSig(CALL_ID, sig, SECRET)).toBe(true);
  });

  it('strips any trailing slash duplication by relying on caller config', () => {
    const url = buildRecordingPublicUrl(CALL_ID, { apiPublicUrl: 'https://api.example.com', secret: SECRET });
    expect(url.split('/recordings/').length).toBe(2);
  });
});
