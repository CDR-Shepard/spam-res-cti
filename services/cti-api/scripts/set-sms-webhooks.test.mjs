/**
 * Tests for the pure, DB/Twilio-free pieces of set-sms-webhooks.mjs (design
 * docs/superpowers/specs/2026-09-25-inbound-texts-design.md, task 7). The
 * script's `main()` connects to a real Postgres database and calls the real
 * Twilio API, gated behind an `isMain` check (see the module's bottom) —
 * importing this module for its exported helpers never touches either.
 */
import { describe, expect, it } from 'vitest';
import { SELECT_NUMBERS_SQL, classifyNumbers, parseArgs, smsWebhookUrl } from './set-sms-webhooks.mjs';

describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ apply: false });
  });

  it('--apply is the only thing that turns writes on', () => {
    expect(parseArgs(['--apply'])).toEqual({ apply: true });
    expect(parseArgs(['--something-else'])).toEqual({ apply: false });
  });
});

describe('smsWebhookUrl — must match routes/inbound-sms.ts byte-for-byte (the signature check depends on it)', () => {
  it('is an exact concatenation: no trailing slash added, no query string, no path normalization', () => {
    expect(smsWebhookUrl('https://ctiapi-production.up.railway.app')).toBe(
      'https://ctiapi-production.up.railway.app/telephony/twilio/sms',
    );
  });

  it('does NOT strip a trailing slash already on API_PUBLIC_URL — it just concatenates, same as inbound-sms.ts', () => {
    expect(smsWebhookUrl('https://example.com/')).toBe('https://example.com//telephony/twilio/sms');
  });
});

describe('SELECT_NUMBERS_SQL — every ACTIVE agent/dialer_pool number with a Twilio sid, nothing else', () => {
  it('filters to active numbers', () => {
    expect(SELECT_NUMBERS_SQL).toMatch(/where\s+active/i);
  });

  it("restricts kind to 'agent' or 'dialer_pool' — never a reserve-only or unknown kind", () => {
    expect(SELECT_NUMBERS_SQL).toMatch(/kind in \('agent',\s*'dialer_pool'\)/);
  });

  it('requires a twilio_sid — nothing this script cannot address at Twilio', () => {
    expect(SELECT_NUMBERS_SQL).toMatch(/twilio_sid is not null/);
  });
});

describe('classifyNumbers — pure split of numbers into already-set / would-change / fetch-failed', () => {
  const DESIRED = 'https://ctiapi-production.up.railway.app/telephony/twilio/sms';
  const n1 = { id: '1', e164: '+16195550100', twilio_sid: 'PN1', kind: 'agent' };
  const n2 = { id: '2', e164: '+16195550101', twilio_sid: 'PN2', kind: 'dialer_pool' };
  const n3 = { id: '3', e164: '+16195550102', twilio_sid: 'PN3', kind: 'agent' };

  it('a number whose SmsUrl and SmsMethod already match exactly is "already set"', () => {
    const configBySid = new Map([[n1.twilio_sid, { smsUrl: DESIRED, smsMethod: 'POST' }]]);
    const { alreadySet, wouldChange, fetchFailed } = classifyNumbers([n1], configBySid, DESIRED);
    expect(alreadySet).toEqual([n1]);
    expect(wouldChange).toEqual([]);
    expect(fetchFailed).toEqual([]);
  });

  it('SmsMethod is compared case-insensitively ("Post" counts as already set)', () => {
    const configBySid = new Map([[n1.twilio_sid, { smsUrl: DESIRED, smsMethod: 'Post' }]]);
    expect(classifyNumbers([n1], configBySid, DESIRED).alreadySet).toEqual([n1]);
  });

  it('a wrong URL, a missing URL, or a non-POST method all count as "would change"', () => {
    const configBySid = new Map([
      [n1.twilio_sid, { smsUrl: 'https://old.example.com/sms', smsMethod: 'POST' }],
      [n2.twilio_sid, { smsUrl: null, smsMethod: null }],
      [n3.twilio_sid, { smsUrl: DESIRED, smsMethod: 'GET' }],
    ]);
    const { wouldChange, alreadySet } = classifyNumbers([n1, n2, n3], configBySid, DESIRED);
    expect(wouldChange).toEqual([n1, n2, n3]);
    expect(alreadySet).toEqual([]);
  });

  it('a number whose Twilio GET failed (no entry in configBySid) is reported separately, never silently "would change"', () => {
    const configBySid = new Map(); // no entry for n1 at all
    const { alreadySet, wouldChange, fetchFailed } = classifyNumbers([n1], configBySid, DESIRED);
    expect(alreadySet).toEqual([]);
    expect(wouldChange).toEqual([]);
    expect(fetchFailed).toEqual([n1]);
  });

  it('a mixed batch splits into all three groups independently', () => {
    const configBySid = new Map([
      [n1.twilio_sid, { smsUrl: DESIRED, smsMethod: 'POST' }],
      [n2.twilio_sid, { smsUrl: 'https://old.example.com', smsMethod: 'POST' }],
      // n3 missing — fetch failed
    ]);
    const { alreadySet, wouldChange, fetchFailed } = classifyNumbers([n1, n2, n3], configBySid, DESIRED);
    expect(alreadySet).toEqual([n1]);
    expect(wouldChange).toEqual([n2]);
    expect(fetchFailed).toEqual([n3]);
  });
});
