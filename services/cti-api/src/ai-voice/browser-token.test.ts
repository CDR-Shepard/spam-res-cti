/**
 * Plan 1E Task 6 (G-4): the "Talk in browser" Voice token can only RECEIVE calls, is bound to the admin who asked,
 * and lives for one AI call plus margin. The JWT is decoded straight from its base64url payload.
 */
import { describe, expect, it } from 'vitest';
import { aiTestIdentityUser } from '@cti/contracts';
import type { AppConfig } from '../config.js';
import { browserCallsAvailable, mintAiTestToken } from './browser-token.js';

const USER = '11111111-2222-4333-8444-555555555555';
const NOW = new Date('2026-10-06T18:00:00.000Z');
const NONCE = 'a1b2c3d4e5f6';
const TWILIO = {
  TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
  TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}`,
  TWILIO_API_KEY_SECRET: 'secret-of-the-api-key',
  AI_VOICE_MAX_CALL_SECONDS: 600,
};

function payloadOf(jwt: string): Record<string, any> {
  const [, body] = jwt.split('.');
  return JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'));
}

describe('mintAiTestToken', () => {
  it('1: an aitest identity, an incoming-only voice grant, and a ttl of one call plus ten minutes', () => {
    const minted = mintAiTestToken(TWILIO, USER, NOW, () => NONCE);
    expect(minted.identity).toBe(`aitest_${USER.replace(/-/g, '')}_${NONCE}`);
    const p = payloadOf(minted.token);
    expect(p.grants.identity).toBe(minted.identity);
    expect(p.grants.voice.incoming).toEqual({ allow: true });
    expect(p.grants.voice.outgoing).toBeUndefined();
    expect(p.grants.voice.push_credential_sid).toBeUndefined();
    expect(Object.keys(p.grants).sort()).toEqual(['identity', 'voice']);
    expect(p.exp - p.iat).toBe(600 + 600);
    expect(p.sub).toBe(TWILIO.TWILIO_ACCOUNT_SID);
    expect(p.iss).toBe(TWILIO.TWILIO_API_KEY_SID);
    expect(minted.expiresAt).toBe(new Date(NOW.getTime() + 1200 * 1000).toISOString());
  });

  it('1: the ttl follows AI_VOICE_MAX_CALL_SECONDS', () => {
    const p = payloadOf(mintAiTestToken({ ...TWILIO, AI_VOICE_MAX_CALL_SECONDS: 300 }, USER, NOW, () => NONCE).token);
    expect(p.exp - p.iat).toBe(900);
  });

  it('2: the identity names the admin who asked, and a fresh nonce makes each run its own identity', () => {
    const a = mintAiTestToken(TWILIO, USER, NOW);
    const b = mintAiTestToken(TWILIO, USER, NOW);
    expect(aiTestIdentityUser(a.identity)).toBe(USER);
    expect(aiTestIdentityUser(b.identity)).toBe(USER);
    expect(a.identity).not.toBe(b.identity);
    expect(a.identity.startsWith('rep_')).toBe(false);
  });
});

describe('browserCallsAvailable', () => {
  const on: Partial<AppConfig> = { ...TWILIO, OPENAI_API_KEY: 'sk', AI_VOICE: 'on', OUTREACH_KILL_SWITCH: 'off' };
  const avail = (over: Partial<AppConfig>) => browserCallsAvailable({ ...on, ...over } as AppConfig);

  it('3: true with AI voice on and the account and API key set; no TwiML App is needed', () => {
    expect(avail({ TWILIO_TWIML_APP_SID: undefined })).toBe(true);
  });

  it.each([
    ['no account SID', { TWILIO_ACCOUNT_SID: undefined }],
    ['no API key SID', { TWILIO_API_KEY_SID: undefined }],
    ['no API key secret', { TWILIO_API_KEY_SECRET: undefined }],
    ['AI voice off', { AI_VOICE: 'off' as const }],
    ['no OpenAI key', { OPENAI_API_KEY: undefined }],
    ['the outreach kill switch on', { OUTREACH_KILL_SWITCH: 'on' as const }],
  ])('3: false with %s', (_label, over) => {
    expect(avail(over)).toBe(false);
  });
});
