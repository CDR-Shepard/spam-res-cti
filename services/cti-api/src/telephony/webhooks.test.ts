import { describe, expect, it } from 'vitest';
import twilio from 'twilio';
import type { FastifyRequest } from 'fastify';
import {
  signedCallbackUrl,
  UUID_RE,
  TWILIO_CALL_SID_RE,
  TWILIO_RECORDING_MEDIA_RE,
} from './webhooks.js';

const TOKEN = 'test-auth-token-123';
const req = (url: string) => ({ url }) as unknown as FastifyRequest;

describe('signedCallbackUrl — Twilio signs the URL INCLUDING the query string', () => {
  it('reconstructs the exact signed URL so a real callback validates', () => {
    const api = 'https://ctiapi-production.up.railway.app';
    const path = '/telephony/twilio/recording?callDbId=11111111-2222-3333-4444-555555555555';
    const full = signedCallbackUrl(api, req(path));
    expect(full).toBe(api + path);

    const params = { CallSid: 'CA' + 'a'.repeat(32), RecordingStatus: 'completed' };
    const sig = twilio.getExpectedTwilioSignature(TOKEN, full, params);

    // The fix: validating against the reconstructed full URL passes.
    expect(twilio.validateRequest(TOKEN, sig, full, params)).toBe(true);
    // Regression guard: the original bug (query string stripped) must NOT pass —
    // that's what silently 403'd every recording callback.
    expect(twilio.validateRequest(TOKEN, sig, api + '/telephony/twilio/recording', params)).toBe(false);
  });
});

describe('shared webhook regexes', () => {
  it('match real Twilio shapes and reject foreign hosts (SSRF guard)', () => {
    expect(UUID_RE.test('11111111-2222-3333-4444-555555555555')).toBe(true);
    expect(TWILIO_CALL_SID_RE.test('CA' + 'f'.repeat(32))).toBe(true);
    expect(TWILIO_CALL_SID_RE.test('XX' + 'f'.repeat(32))).toBe(false);
    expect(
      TWILIO_RECORDING_MEDIA_RE.test('https://api.twilio.com/2010-04-01/Accounts/ACx/Recordings/REx'),
    ).toBe(true);
    expect(TWILIO_RECORDING_MEDIA_RE.test('https://evil.example.com/api.twilio.com/x')).toBe(false);
    expect(TWILIO_RECORDING_MEDIA_RE.test('https://api.twilio.com.evil.com/x')).toBe(false);
  });
});
