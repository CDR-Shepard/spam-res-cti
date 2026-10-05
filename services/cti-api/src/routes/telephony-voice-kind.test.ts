/**
 * The click-to-dial leg (POST /telephony/twilio/voice, no DialerConference)
 * re-checks the DID at DIAL time. It must refuse a call row whose caller ID is
 * an AI (`ai_pool`) number — the last line after the firewall and POST /calls.
 * Harness idiom: telephony-voice-conference.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const CALL_ID = '11111111-2222-4333-8444-555555555555';
const FROM = '+16197244374';

const state = vi.hoisted(() => ({
  did: null as Record<string, unknown> | null,
  didWhere: [] as unknown[],
}));

vi.mock('../config.js', () => ({
  loadConfig: () => ({ API_PUBLIC_URL: 'https://api.test', TWILIO_SKIP_SIGNATURE_CHECK: false, TWILIO_RECORD_CALLS: false }),
}));
vi.mock('../telephony/index.js', () => ({
  getProvider: () => ({ validateWebhook: () => ({ valid: true }) }),
}));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => null,
}));
vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return {
    ...actual,
    getDb: () => ({
      query: {
        calls: {
          findFirst: async () => ({
            id: CALL_ID, orgId: 'O1', fromNumber: FROM, normalizedToNumber: '+16195559999',
            preCallAuditId: 'A1', createdAt: new Date(), providerCallId: null, campaignKey: null,
          }),
        },
        preCallAudits: { findFirst: async () => ({ id: 'A1', decision: 'ALLOW' }) },
        outboundNumbers: {
          findFirst: async (opts: { where: unknown }) => {
            state.didWhere.push(opts.where);
            return state.did ?? undefined;
          },
        },
        campaignConfigs: { findFirst: async () => undefined },
      },
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: CALL_ID }] }) }) }),
    }),
  };
});

import { registerTelephonyRoutes } from './telephony.js';

const row = (kind: string) => ({ id: 'N1', orgId: 'O1', e164: FROM, kind, active: true, health: 'healthy' });

let app: FastifyInstance;
beforeEach(async () => {
  state.did = null;
  state.didWhere = [];
  app = Fastify();
  await registerTelephonyRoutes(app);
  await app.ready();
});
afterEach(async () => { await app.close(); });

const voice = () => app.inject({ method: 'POST', url: '/telephony/twilio/voice', payload: { CallId: CALL_ID, CallSid: 'CA1' } });

describe('POST /telephony/twilio/voice — never dials a rep call from an ai_pool number', () => {
  it('the dial-time DID re-check is rep-kind only', async () => {
    state.did = row('agent');
    await voice();
    const { sql, params } = new PgDialect().sqlToQuery(state.didWhere[0] as SQL);
    expect(sql).toContain('"outbound_numbers"."kind" in (');
    expect(params).toEqual(expect.arrayContaining(['agent', 'dialer_pool']));
    expect(params).not.toContain('ai_pool');
  });

  it('an ai_pool caller ID is refused: no <Dial>', async () => {
    state.did = row('ai_pool');
    const res = await voice();
    expect(res.body).toContain('no longer available');
    expect(res.body).not.toContain('<Dial');
  });

  it('control: an agent number dials', async () => {
    state.did = row('agent');
    const res = await voice();
    expect(res.body).toContain(`<Dial callerId="${FROM}"`);
  });
});
