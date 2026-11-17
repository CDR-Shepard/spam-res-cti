/**
 * Tests for buy-pool-numbers.mjs (review minor: newly-bought numbers must
 * also get SmsUrl/SmsMethod set, using the same URL builder as
 * set-sms-webhooks.mjs, or they'd sit uncovered until someone remembers to
 * re-run that script). `main()` connects to real Twilio/Postgres and is
 * gated behind an `isMain` check (see the module's bottom) — importing this
 * module for `purchaseFields` never touches either.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handoffPath, purchaseFields } from './buy-pool-numbers.mjs';

describe('handoffPath — where purchased numbers are recorded between buy and register', () => {
  it('POOL_OUTFILE overrides the default', () => {
    expect(handoffPath({ POOL_OUTFILE: '/somewhere/else/pool.json' })).toBe('/somewhere/else/pool.json');
  });

  it('defaults to pool-buy.json in services/cti-api — a folder that exists on every checkout, not one machine', () => {
    const serviceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const path = handoffPath({});
    expect(path).toBe(join(serviceDir, 'pool-buy.json'));
    // The purchase is charged BEFORE the handoff is written, so a default in
    // a folder that isn't there loses the only record of a paid-for number.
    expect(existsSync(dirname(path))).toBe(true);
  });
});

describe('purchaseFields — the Twilio purchase request body', () => {
  it('sets VoiceUrl/VoiceMethod AND SmsUrl/SmsMethod=POST, plus PhoneNumber/FriendlyName, and nothing else', () => {
    expect(
      purchaseFields('+16195550100', 'https://ctiapi-production.up.railway.app/telephony/twilio/inbound', 'https://ctiapi-production.up.railway.app/telephony/twilio/sms', 'Dialer Pool 619'),
    ).toEqual({
      PhoneNumber: '+16195550100',
      VoiceUrl: 'https://ctiapi-production.up.railway.app/telephony/twilio/inbound',
      VoiceMethod: 'POST',
      SmsUrl: 'https://ctiapi-production.up.railway.app/telephony/twilio/sms',
      SmsMethod: 'POST',
      FriendlyName: 'Dialer Pool 619',
    });
  });
});

// ---------------------------------------------------------------------------
// doBuy() — the ACTUAL call site, not just purchaseFields() in isolation.
// Review round 2, B1: mutating the call site to revert to the old inline
// body, or to build SmsUrl from the voice URL, survived every existing test
// — none of them ever executed doBuy() itself. ACCOUNT/TOKEN/API_BASE/
// CONFIRM/HANDOFF are read from process.env at module load, so this needs a
// fresh dynamic import per test after setting env vars.
// ---------------------------------------------------------------------------

describe('doBuy — the real Twilio purchase call site (review round 2, B1)', () => {
  // Each test gets its own throwaway folder for the handoff file and removes
  // it afterwards — nothing here depends on a path that exists on one machine.
  let handoffDir;

  beforeEach(() => {
    handoffDir = mkdtempSync(join(tmpdir(), 'buy-pool-numbers-test-'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MODE;
    delete process.env.CONFIRM_BUY;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.POOL_API_BASE;
    delete process.env.POOL_OUTFILE;
    rmSync(handoffDir, { recursive: true, force: true });
  });

  it('the purchase POST body uses the SMS url builder (not the voice url), and includes VoiceMethod', async () => {
    const handoffFile = join(handoffDir, 'pool-buy.json');
    process.env.MODE = 'buy';
    process.env.CONFIRM_BUY = '1';
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    process.env.POOL_API_BASE = 'https://ctiapi-production.up.railway.app';
    process.env.POOL_OUTFILE = handoffFile;

    const calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        calls.push({ url, init });
        if (init?.method === 'POST') {
          return new Response(JSON.stringify({ phone_number: '+16195550100', sid: 'PN00000000000000000000000000000000' }), { status: 200 });
        }
        // GET (search available numbers) — always return one candidate.
        return new Response(JSON.stringify({ available_phone_numbers: [{ phone_number: '+16195550100' }] }), { status: 200 });
      }),
    );

    vi.resetModules();
    const mod = await import('./buy-pool-numbers.mjs');
    await mod.doBuy();

    const posts = calls.filter((c) => c.init?.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    const body = Object.fromEntries(new URLSearchParams(posts[0].init.body));
    expect(body).toEqual({
      PhoneNumber: '+16195550100',
      VoiceUrl: 'https://ctiapi-production.up.railway.app/telephony/twilio/inbound',
      VoiceMethod: 'POST',
      SmsUrl: 'https://ctiapi-production.up.railway.app/telephony/twilio/sms',
      SmsMethod: 'POST',
      FriendlyName: expect.stringContaining('Dialer Pool'),
    });

    // The handoff landed in this test's own folder: one record per purchase.
    const handoff = JSON.parse(readFileSync(handoffFile, 'utf8'));
    expect(handoff).toHaveLength(posts.length);
    expect(handoff[0]).toMatchObject({ e164: '+16195550100', sid: 'PN00000000000000000000000000000000' });
  });
});
