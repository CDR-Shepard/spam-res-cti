/**
 * registerAiVoiceRoutes mounts the internal AI call routes (plan 1C) beside the rep routes,
 * with no database opened at registration, and the rep routes' JSON parsing is untouched by
 * the internal scope's raw-body parser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { internalRequestHeaders } from '@cti/auth';
import { INTERNAL_AI_AVAILABILITY_PATH, INTERNAL_AI_CALLS_PATH } from '@cti/contracts';

const state = vi.hoisted(() => ({ cfg: {} as Record<string, unknown>, dbOpened: 0 }));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadConfig: () => state.cfg,
}));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => null,
}));
vi.mock('@cti/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/db')>()),
  getDb: () => {
    state.dbOpened += 1;
    return {};
  },
}));

import { registerAiVoiceRoutes } from './routes.js';
import { defaultToolEffects } from './service-tools.js';
import { fakeStore, fakeTwilio } from './testing.js';

const SECRET = 'w'.repeat(40);
const NOW = new Date('2026-10-05T18:00:00Z');
let app: FastifyInstance;

beforeEach(async () => {
  state.dbOpened = 0;
  state.cfg = {
    NODE_ENV: 'production',
    API_PUBLIC_URL: 'https://api.test',
    SESSION_SECRET: 's'.repeat(40),
    OPENAI_API_KEY: 'sk-test',
    AI_VOICE: 'on',
    OUTREACH_KILL_SWITCH: 'off',
    AI_VOICE_TEST_NUMBERS: '+16195550199',
    OUTREACH_INTERNAL_SECRET: SECRET,
  };
  app = Fastify();
  await registerAiVoiceRoutes(app, {
    store: fakeStore(),
    twilio: fakeTwilio(),
    loadRecord: async () => null,
    gate: async () => ({ ok: false, reason: 'no_consent' }),
    now: () => NOW,
    afterCall: async () => {},
    effects: defaultToolEffects,
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

const signedGet = () =>
  app.inject({
    method: 'GET',
    url: INTERNAL_AI_AVAILABILITY_PATH,
    headers: { host: 'ctiapi.railway.internal', ...internalRequestHeaders(SECRET, { method: 'GET', path: INTERNAL_AI_AVAILABILITY_PATH, body: '' }, NOW) },
  });

describe('internal AI call routes, as registered by registerAiVoiceRoutes', () => {
  it('registering opens no database', () => {
    expect(state.dbOpened).toBe(0);
  });

  it('serves the signed availability check on the private host', async () => {
    const res = await signedGet();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, testNumbers: ['+16195550199'] });
  });

  it('answers 503 while OUTREACH_INTERNAL_SECRET is unset (the default today)', async () => {
    delete state.cfg.OUTREACH_INTERNAL_SECRET;
    expect((await signedGet()).statusCode).toBe(503);
  });

  it('does not exist on the public host in production', async () => {
    const res = await app.inject({ method: 'POST', url: INTERNAL_AI_CALLS_PATH, headers: { host: 'api.test', 'content-type': 'application/json' }, payload: '{}' });
    expect(res.statusCode).toBe(404);
  });

  it("the rep routes still parse JSON normally (the raw parser is scoped to the internal routes)", async () => {
    const res = await app.inject({ method: 'POST', url: '/ai-calls', headers: { 'content-type': 'application/json' }, payload: '{"testTo":"+16195550199"}' });
    expect(res.statusCode).toBe(401); // reached the handler: parsed, then refused for having no session
  });
});
