/**
 * A small test for buy-agent-numbers.ts (review minor: newly-bought numbers
 * must also get SmsUrl/SmsMethod set, using the same URL builder as
 * set-sms-webhooks.mjs, or they'd sit uncovered until someone remembers to
 * re-run that script). The rest of this script connects to real Twilio/
 * Postgres and is gated behind an `isMain` check (see the module's bottom)
 * — importing it for `purchaseFields` never touches either.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { purchaseFields } from './buy-agent-numbers.js';

describe('purchaseFields — the Twilio purchase request body', () => {
  it('sets VoiceUrl/VoiceMethod AND SmsUrl/SmsMethod=POST, plus PhoneNumber/FriendlyName, and nothing else', () => {
    expect(
      purchaseFields(
        '+16195550100',
        'https://ctiapi-production.up.railway.app/telephony/twilio/inbound',
        'https://ctiapi-production.up.railway.app/telephony/twilio/sms',
        'Agent evren LA',
      ),
    ).toEqual({
      PhoneNumber: '+16195550100',
      VoiceUrl: 'https://ctiapi-production.up.railway.app/telephony/twilio/inbound',
      VoiceMethod: 'POST',
      SmsUrl: 'https://ctiapi-production.up.railway.app/telephony/twilio/sms',
      SmsMethod: 'POST',
      FriendlyName: 'Agent evren LA',
    });
  });
});

// ---------------------------------------------------------------------------
// buyBatch() — the ACTUAL call site, not just purchaseFields() in isolation.
// Review round 2, B2: mutating the call site to revert to the old inline
// body, or to build SmsUrl from the voice URL, survived every existing test
// — none of them ever executed buyBatch() itself. It touches only Twilio,
// never the database. ACCOUNT/TOKEN/API_BASE/CONFIRM/HANDOFF are read from
// process.env at module load, so this needs a fresh dynamic import per test
// after setting env vars.
// ---------------------------------------------------------------------------

describe('buyBatch — the real Twilio purchase call site (review round 2, B2)', () => {
  // Each test gets its own throwaway folder for the hand-off file and removes
  // it afterwards — nothing here depends on a path that exists on one machine.
  let handoffDir: string;

  beforeEach(() => {
    handoffDir = mkdtempSync(join(tmpdir(), 'buy-agent-numbers-test-'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CONFIRM_BUY;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.POOL_API_BASE;
    delete process.env.FLEET_OUTFILE;
    rmSync(handoffDir, { recursive: true, force: true });
  });

  it('the purchase POST body uses the SMS url builder (not the voice url), and includes VoiceMethod', async () => {
    const handoffFile = join(handoffDir, 'fleet-buy.json');
    process.env.CONFIRM_BUY = '1';
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'test-token';
    process.env.POOL_API_BASE = 'https://ctiapi-production.up.railway.app';
    process.env.FLEET_OUTFILE = handoffFile;

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (init?.method === 'POST') {
          return new Response(JSON.stringify({ phone_number: '+16195550100', sid: 'PN00000000000000000000000000000000' }), { status: 200 });
        }
        return new Response(JSON.stringify({ available_phone_numbers: [{ phone_number: '+16195550100' }] }), { status: 200 });
      }),
    );

    vi.resetModules();
    const mod = await import('./buy-agent-numbers.js');
    const bought: unknown[] = [];
    await mod.buyBatch(['619'], 1, 'agent', 'Agent Test LA', null, bought as never);

    const posts = calls.filter((c) => c.init?.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    const body = Object.fromEntries(new URLSearchParams(posts[0]!.init!.body as string));
    expect(body).toEqual({
      PhoneNumber: '+16195550100',
      VoiceUrl: 'https://ctiapi-production.up.railway.app/telephony/twilio/inbound',
      VoiceMethod: 'POST',
      SmsUrl: 'https://ctiapi-production.up.railway.app/telephony/twilio/sms',
      SmsMethod: 'POST',
      FriendlyName: 'Agent Test LA',
    });

    // The hand-off landed in this test's own folder, and the atomic write
    // left no .tmp sibling behind.
    expect(readdirSync(handoffDir)).toEqual(['fleet-buy.json']);
    expect(JSON.parse(readFileSync(handoffFile, 'utf8'))).toEqual([
      { e164: '+16195550100', sid: 'PN00000000000000000000000000000000', kind: 'agent', label: 'Agent Test LA', assignEmail: null },
    ]);
  });
});
