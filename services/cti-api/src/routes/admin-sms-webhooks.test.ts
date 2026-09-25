/**
 * Route-level tests for the two admin paths that talk to Twilio's
 * IncomingPhoneNumbers API and must, per the inbound-texts design (docs/
 * superpowers/specs/2026-09-25-inbound-texts-design.md, task 7), set SmsUrl /
 * SmsMethod ALONGSIDE VoiceUrl / VoiceMethod so a newly-registered or
 * newly-imported number is covered from the start — the ops script
 * (set-sms-webhooks.mjs) only back-fills numbers that predate this change.
 *
 * Harness follows admin-team.test.ts: hoisted `state`, `vi.mock` of
 * `@cti/auth` and `@cti/db`, Fastify + registerAdminRoutes. Twilio itself is
 * `fetch`, called directly (no SDK, no injected client) — `vi.stubGlobal`
 * intercepts it so these tests never make a real network call and can pin the
 * exact form body Twilio receives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const CFG = {
  TWILIO_ACCOUNT_SID: 'ACtest0000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'test-auth-token',
  API_PUBLIC_URL: 'https://ctiapi-production.up.railway.app',
};

const state = vi.hoisted(() => ({
  authedUser: null as { userId: string; orgId: string; email: string; isAdmin: boolean } | null,
  ownedNumber: null as { id: string; orgId: string } | null,
  insertedValues: [] as Array<Record<string, unknown>>,
  onConflictSets: [] as Array<Record<string, unknown>>,
  cfg: null as Record<string, unknown> | null,
}));

vi.mock('../config.js', () => ({
  loadConfig: () => state.cfg,
}));

vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async (_bearer: string | undefined) => state.authedUser,
}));

vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return { ...actual, getDb: () => fakeDb() };
});

import { registerAdminRoutes } from './admin.js';

/**
 * Just enough of the drizzle surface the two routes under test touch:
 *  - `query.outboundNumbers.findFirst(...)` -> the configurable owned number
 *    (register-twilio-inbound's ownership check).
 *  - `insert(schema.outboundNumbers).values(v).onConflictDoUpdate({ set })`
 *    -> records both, resolves with no `.returning()` (import-twilio never
 *    calls it), matching admin.ts's real call shape exactly.
 */
function fakeDb() {
  return {
    query: {
      outboundNumbers: {
        findFirst: async (_opts?: unknown) => state.ownedNumber,
      },
    },
    insert(_table: unknown) {
      return {
        values(v: Record<string, unknown>) {
          state.insertedValues.push(v);
          return {
            onConflictDoUpdate(conf: { set: Record<string, unknown> }) {
              state.onConflictSets.push(conf.set);
              return Promise.resolve(undefined);
            },
          };
        },
      };
    },
  };
}

let app: FastifyInstance;
const admin = { userId: 'a1', orgId: 'o1', email: 'admin@x.com', isAdmin: true };
const NUMBER_ID = '11111111-1111-1111-1111-111111111111';
const TWILIO_SID = 'PN00000000000000000000000000000000';

/** Every fetch call this test session made, in order: [url, RequestInit]. */
let fetchCalls: Array<[string, RequestInit | undefined]>;
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

beforeEach(async () => {
  state.authedUser = null;
  state.ownedNumber = { id: NUMBER_ID, orgId: 'o1' };
  state.insertedValues = [];
  state.onConflictSets = [];
  state.cfg = CFG;
  fetchCalls = [];
  // Default: every Twilio call succeeds with a minimal IncomingPhoneNumber body.
  fetchImpl = async (url, init) => {
    fetchCalls.push([url, init]);
    return new Response(JSON.stringify({ sid: TWILIO_SID, phone_number: '+16195550100' }), { status: 200 });
  };
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => fetchImpl(url, init)));
  app = Fastify();
  await registerAdminRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
});

describe('POST /admin/outbound-numbers/:id/register-twilio-inbound — sets SmsUrl alongside VoiceUrl', () => {
  it('the Twilio form body sets VoiceUrl+VoiceMethod AND SmsUrl+SmsMethod, and nothing else', async () => {
    state.authedUser = admin;
    const res = await app.inject({
      method: 'POST',
      url: `/admin/outbound-numbers/${NUMBER_ID}/register-twilio-inbound`,
      payload: { twilioSid: TWILIO_SID },
    });
    expect(res.statusCode).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    const [url, init] = fetchCalls[0]!;
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${CFG.TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers/${TWILIO_SID}.json`);
    expect(init!.method).toBe('POST');
    // Exact body, pinned: order matters as much as content — a stray extra
    // field here would be an accidental Twilio config change.
    expect(init!.body).toBe('VoiceUrl=https%3A%2F%2Fctiapi-production.up.railway.app%2Ftelephony%2Ftwilio%2Finbound&VoiceMethod=POST&SmsUrl=https%3A%2F%2Fctiapi-production.up.railway.app%2Ftelephony%2Ftwilio%2Fsms&SmsMethod=POST');
  });

  it('the response reports both URLs it set', async () => {
    state.authedUser = admin;
    const res = await app.inject({
      method: 'POST',
      url: `/admin/outbound-numbers/${NUMBER_ID}/register-twilio-inbound`,
      payload: { twilioSid: TWILIO_SID },
    });
    expect(res.json()).toMatchObject({
      ok: true,
      voiceUrl: 'https://ctiapi-production.up.railway.app/telephony/twilio/inbound',
      smsUrl: 'https://ctiapi-production.up.railway.app/telephony/twilio/sms',
    });
  });

  it('401 without a session, 403 for a non-admin, 404 for a number in another org', async () => {
    const res401 = await app.inject({
      method: 'POST',
      url: `/admin/outbound-numbers/${NUMBER_ID}/register-twilio-inbound`,
      payload: { twilioSid: TWILIO_SID },
    });
    expect(res401.statusCode).toBe(401);

    state.authedUser = { ...admin, isAdmin: false };
    const res403 = await app.inject({
      method: 'POST',
      url: `/admin/outbound-numbers/${NUMBER_ID}/register-twilio-inbound`,
      payload: { twilioSid: TWILIO_SID },
    });
    expect(res403.statusCode).toBe(403);

    state.authedUser = admin;
    state.ownedNumber = null;
    const res404 = await app.inject({
      method: 'POST',
      url: `/admin/outbound-numbers/${NUMBER_ID}/register-twilio-inbound`,
      payload: { twilioSid: TWILIO_SID },
    });
    expect(res404.statusCode).toBe(404);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('POST /admin/outbound-numbers/import-twilio — sets SmsUrl alongside VoiceUrl for every imported number', () => {
  function stubTwilioList(numbers: Array<{ phone_number: string; sid: string; friendly_name?: string }>) {
    fetchImpl = async (url, init) => {
      fetchCalls.push([url, init]);
      if (url.includes('/IncomingPhoneNumbers.json')) {
        return new Response(JSON.stringify({ incoming_phone_numbers: numbers, next_page_uri: null }), { status: 200 });
      }
      // The per-number webhook PATCH.
      return new Response(JSON.stringify({ sid: TWILIO_SID }), { status: 200 });
    };
  }

  it('sets both VoiceUrl and SmsUrl on the per-number webhook PATCH for every imported number', async () => {
    state.authedUser = admin;
    stubTwilioList([{ phone_number: '+16195550100', sid: 'PN11111111111111111111111111111111' }]);
    const res = await app.inject({ method: 'POST', url: '/admin/outbound-numbers/import-twilio' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, found: 1, registered: 1, inboundWebhooksSet: 1 });

    const patchCall = fetchCalls.find(([url]) => url.includes('PN11111111111111111111111111111111'));
    expect(patchCall).toBeDefined();
    const [, init] = patchCall!;
    expect(init!.body).toBe(
      'VoiceUrl=https%3A%2F%2Fctiapi-production.up.railway.app%2Ftelephony%2Ftwilio%2Finbound&VoiceMethod=POST&SmsUrl=https%3A%2F%2Fctiapi-production.up.railway.app%2Ftelephony%2Ftwilio%2Fsms&SmsMethod=POST',
    );
  });

  it('a webhook-set failure for one number does not abort the import (best-effort, matching the existing VoiceUrl behavior)', async () => {
    state.authedUser = admin;
    let n = 0;
    fetchImpl = async (url) => {
      fetchCalls.push([url, undefined]);
      if (url.includes('/IncomingPhoneNumbers.json')) {
        return new Response(
          JSON.stringify({ incoming_phone_numbers: [{ phone_number: '+16195550100', sid: 'PN22222222222222222222222222222222' }], next_page_uri: null }),
          { status: 200 },
        );
      }
      n++;
      return new Response('', { status: 500 });
    };
    const res = await app.inject({ method: 'POST', url: '/admin/outbound-numbers/import-twilio' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, registered: 1, inboundWebhooksSet: 0 });
    expect(n).toBe(1);
  });

  it('403 for a non-admin', async () => {
    state.authedUser = { ...admin, isAdmin: false };
    const res403 = await app.inject({ method: 'POST', url: '/admin/outbound-numbers/import-twilio' });
    expect(res403.statusCode).toBe(403);
  });

  it('503 when Twilio creds are unset — never silently skips the import', async () => {
    state.authedUser = admin;
    state.cfg = { ...CFG, TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined };
    const res = await app.inject({ method: 'POST', url: '/admin/outbound-numbers/import-twilio' });
    expect(res.statusCode).toBe(503);
    expect(fetchCalls).toHaveLength(0);
  });
});
