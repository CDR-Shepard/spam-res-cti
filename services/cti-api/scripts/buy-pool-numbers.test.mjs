/**
 * Tests for buy-pool-numbers.mjs (review minor: newly-bought numbers must
 * also get SmsUrl/SmsMethod set, using the same URL builder as
 * set-sms-webhooks.mjs, or they'd sit uncovered until someone remembers to
 * re-run that script). `main()` connects to real Twilio/Postgres and is
 * gated behind an `isMain` check (see the module's bottom) — importing this
 * module for `purchaseFields` never touches either.
 */
import { unlinkSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { purchaseFields } from './buy-pool-numbers.mjs';

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
  const HANDOFF_PATH = '/private/tmp/claude-501/-Users-cdrshepard-spam-res-cti/afd1f56e-293d-4ea6-9400-11116185f1f2/scratchpad/buy-pool-numbers-test-handoff.json';

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MODE;
    delete process.env.CONFIRM_BUY;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.POOL_API_BASE;
    delete process.env.POOL_OUTFILE;
    try {
      unlinkSync(HANDOFF_PATH);
    } catch {
      // fine — the test may not have gotten far enough to write it
    }
  });

  it('the purchase POST body uses the SMS url builder (not the voice url), and includes VoiceMethod', async () => {
    process.env.MODE = 'buy';
    process.env.CONFIRM_BUY = '1';
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    process.env.POOL_API_BASE = 'https://ctiapi-production.up.railway.app';
    process.env.POOL_OUTFILE = HANDOFF_PATH;

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
  });
});
