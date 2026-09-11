/**
 * POST /telephony/twilio/status must acknowledge with a content type Twilio
 * accepts. The duplicate-event branch answered with JSON, and Twilio logged
 * error 12300 "Invalid Content-Type: application/json" for every duplicate
 * status callback (5–14 a day), burying real alerts. Harness idiom:
 * routes/admin-team.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({ insertThrows: true, inserted: 0 }));

vi.mock('../config.js', () => ({
  loadConfig: () => ({ API_PUBLIC_URL: 'https://api.test', TWILIO_SKIP_SIGNATURE_CHECK: true }),
}));
vi.mock('../telephony/index.js', () => ({
  getProvider: () => ({ name: 'twilio', validateWebhook: () => ({ valid: true }) }),
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
      insert: (_table: unknown) => ({
        values: async (_v: unknown) => {
          state.inserted++;
          if (state.insertThrows) throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
        },
      }),
    }),
  };
});

import { registerTelephonyRoutes } from './telephony.js';

let app: FastifyInstance;
beforeEach(async () => {
  state.insertThrows = true;
  state.inserted = 0;
  app = Fastify();
  await registerTelephonyRoutes(app);
  await app.ready();
});
afterEach(async () => { await app.close(); });

describe('POST /telephony/twilio/status — duplicate event acknowledgement', () => {
  it('acks a replayed status callback with empty TwiML as text/xml, never JSON', async () => {
    const res = await app.inject({ method: 'POST', url: '/telephony/twilio/status', payload: { CallSid: 'CA1', CallStatus: 'completed' } });
    expect(state.inserted).toBe(1);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  });
});
