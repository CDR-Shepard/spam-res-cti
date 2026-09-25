/**
 * POST /telephony/twilio/sms — every text to one of our numbers is stored once
 * and answered with an empty <Response/> at once.
 *
 * Route-level (Fastify + fake-DB injection), following inbound.test.ts. The fake
 * `insert` mimics the real unique index on message_sid (a second insert of the
 * same sid returns no row), and the real emitted SQL is pinned separately so the
 * fake cannot drift from what Postgres actually runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  inboundTexts: 'on' as 'on' | 'off',
  skipSig: false,
  sigValid: true,
  signedUrls: [] as string[],
  owned: null as Record<string, unknown> | null,
  ownedWheres: [] as unknown[],
  /** Rows the fake inbound_messages table holds, keyed by message_sid (the unique index). */
  rows: new Map<string, Record<string, unknown>>(),
  insertError: null as Error | null,
  stickyAgentId: null as string | null,
  lastDialerId: null as string | null,
  stickyError: null as Error | null,
  lastDialerError: null as Error | null,
  stickyAgentForCaller: vi.fn(),
  lastDialerForCaller: vi.fn(),
}));

vi.mock('../config.js', () => ({
  loadConfig: () => ({
    API_PUBLIC_URL: 'https://api.example.com',
    TELEPHONY_PROVIDER: 'twilio',
    get TWILIO_SKIP_SIGNATURE_CHECK() {
      return state.skipSig;
    },
    get INBOUND_TEXTS() {
      return state.inboundTexts;
    },
  }),
}));

vi.mock('../telephony/index.js', () => ({
  getProvider: () => ({
    name: 'twilio',
    validateWebhook: (_h: unknown, _raw: string, url: string) => {
      state.signedUrls.push(url);
      return state.sigValid ? { valid: true } : { valid: false, reason: 'Bad signature' };
    },
  }),
}));

vi.mock('../dialer/sticky.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dialer/sticky.js')>();
  return { ...actual, stickyAgentForCaller: state.stickyAgentForCaller, lastDialerForCaller: state.lastDialerForCaller };
});

vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return { ...actual, getDb: () => fakeDb() };
});

import { schema } from '@cti/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { EMPTY_TWIML, insertInboundMessage, registerInboundSmsRoutes } from './inbound-sms.js';

function fakeDb() {
  return {
    query: {
      outboundNumbers: {
        findFirst: async (args: { where: unknown }) => {
          state.ownedWheres.push(args.where);
          return state.owned;
        },
      },
    },
    insert(table: unknown) {
      if (table !== schema.inboundMessages) throw new Error('unexpected insert target');
      return {
        values(v: Record<string, unknown>) {
          const returning = async () => {
            if (state.insertError) throw state.insertError;
            const sid = String(v.messageSid);
            if (state.rows.has(sid)) return [];
            state.rows.set(sid, v);
            return [{ id: `row-${state.rows.size}` }];
          };
          return { onConflictDoNothing: () => ({ returning }) };
        },
      };
    },
  } as unknown as ReturnType<typeof import('@cti/db').getDb>;
}

const SID_1 = 'SM0123456789abcdef0123456789abcdef';
const SID_2 = 'MMfedcba9876543210fedcba9876543210';
const SECRET_BODY = 'my gate code is 4471';

const OWNED = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'num-1',
  orgId: 'org-1',
  e164: '+16195550100',
  kind: 'agent',
  assignedUserId: 'rep-1',
  active: true,
  ...over,
});

let app: FastifyInstance;
let logLines: string[];

beforeEach(async () => {
  state.inboundTexts = 'on';
  state.skipSig = false;
  state.sigValid = true;
  state.signedUrls = [];
  state.owned = OWNED();
  state.ownedWheres = [];
  state.rows = new Map();
  state.insertError = null;
  state.stickyAgentId = null;
  state.lastDialerId = null;
  state.stickyError = null;
  state.lastDialerError = null;
  state.stickyAgentForCaller.mockReset();
  state.stickyAgentForCaller.mockImplementation(async () => {
    if (state.stickyError) throw state.stickyError;
    return state.stickyAgentId;
  });
  state.lastDialerForCaller.mockReset();
  state.lastDialerForCaller.mockImplementation(async () => {
    if (state.lastDialerError) throw state.lastDialerError;
    return state.lastDialerId;
  });
  logLines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk));
      cb();
    },
  });
  app = Fastify({ logger: { level: 'info', stream } });
  // Mirror server.ts's raw-body capturing parser (signature validation reads it).
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody?: string }).rawBody = body as string;
    const params: Record<string, string> = {};
    new URLSearchParams(body as string).forEach((v, k) => {
      params[k] = v;
    });
    done(null, params);
  });
  await registerInboundSmsRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

function text(overrides: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/telephony/twilio/sms',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'sig' },
    payload: new URLSearchParams({
      MessageSid: SID_1,
      From: '+13105550002',
      To: '+16195550100',
      Body: SECRET_BODY,
      NumMedia: '0',
      ...overrides,
    }).toString(),
  });
}

function expectEmptyTwiml(res: Awaited<ReturnType<typeof text>>): void {
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toMatch(/^text\/xml/);
  expect(res.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
}

describe('POST /telephony/twilio/sms — signature', () => {
  it('403s a request whose Twilio signature does not validate, and stores nothing', async () => {
    state.sigValid = false;
    const res = await text();
    expect(res.statusCode).toBe(403);
    expect(state.rows.size).toBe(0);
  });

  it('validates against the exact public URL Twilio is configured to call', async () => {
    await text();
    expect(state.signedUrls).toEqual(['https://api.example.com/telephony/twilio/sms']);
  });

  it('the local-dev skip flag lets an unsigned request through (never set in production)', async () => {
    state.sigValid = false;
    state.skipSig = true;
    expectEmptyTwiml(await text());
    expect(state.rows.size).toBe(1);
  });
});

describe('POST /telephony/twilio/sms — INBOUND_TEXTS kill switch', () => {
  it('off: still answers <Response/> (never an error a texter could see) but stores and looks up nothing', async () => {
    state.inboundTexts = 'off';
    expectEmptyTwiml(await text());
    expect(state.rows.size).toBe(0);
    expect(state.ownedWheres).toHaveLength(0);
    const line = logLines.find((l) => l.includes('inbound_sms_disabled'));
    expect(line).toContain(SID_1);
    expect(logLines.join('\n')).not.toContain(SECRET_BODY);
  });

  it('off: an unsigned request is still refused', async () => {
    state.inboundTexts = 'off';
    state.sigValid = false;
    expect((await text()).statusCode).toBe(403);
  });
});

describe('POST /telephony/twilio/sms — storing the text', () => {
  it('answers an empty <Response/> (no auto-reply) and stores a pending row for the rep', async () => {
    const before = Date.now();
    expectEmptyTwiml(await text({ NumMedia: '2' }));
    expect(EMPTY_TWIML).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    const row = state.rows.get(SID_1)!;
    expect(row).toMatchObject({
      orgId: 'org-1',
      messageSid: SID_1,
      fromE164: '+13105550002',
      toE164: '+16195550100',
      body: SECRET_BODY,
      numMedia: 2,
      userId: 'rep-1',
      status: 'pending',
      backfill: false,
    });
    expect((row.receivedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('normalises To and From to E.164 before the lookup and the insert', async () => {
    await text({ To: '(619) 555-0100', From: '310-555-0002' });
    const { params } = new PgDialect().sqlToQuery(state.ownedWheres[0] as SQL);
    expect(params).toEqual(['+16195550100']);
    expect(state.rows.get(SID_1)).toMatchObject({ fromE164: '+13105550002', toE164: '+16195550100' });
  });

  it('a duplicate MessageSid (Twilio retry) stores once and still answers <Response/>', async () => {
    expectEmptyTwiml(await text());
    expectEmptyTwiml(await text({ Body: 'a different body on the retry' }));
    expect(state.rows.size).toBe(1);
    expect(state.rows.get(SID_1)!.body).toBe(SECRET_BODY);
  });

  it('two different texts are two rows', async () => {
    await text();
    await text({ MessageSid: SID_2 });
    expect([...state.rows.keys()]).toEqual([SID_1, SID_2]);
  });

  it('an unknown To answers <Response/>, stores nothing, and logs the MessageSid', async () => {
    state.owned = null;
    expectEmptyTwiml(await text());
    expect(state.rows.size).toBe(0);
    const line = logLines.find((l) => l.includes('inbound_sms_unknown_number'));
    expect(line).toBeDefined();
    expect(line).toContain(SID_1);
  });

  it('a missing or malformed MessageSid answers <Response/> and stores nothing', async () => {
    expectEmptyTwiml(await text({ MessageSid: '' }));
    expectEmptyTwiml(await text({ MessageSid: 'not-a-sid' }));
    expect(state.rows.size).toBe(0);
  });

  it('a non-numeric NumMedia is stored as 0, never NaN', async () => {
    await text({ NumMedia: 'lots' });
    expect(state.rows.get(SID_1)!.numMedia).toBe(0);
  });

  it('a picture with no words stores an empty body', async () => {
    await text({ Body: '', NumMedia: '1' });
    expect(state.rows.get(SID_1)).toMatchObject({ body: '', numMedia: 1 });
  });

  it('an unexpected error still answers <Response/> (never a 500 Twilio would retry) and never logs the body', async () => {
    // A Postgres constraint violation carries the whole failing row — body
    // included — in `detail`. Logging the raw error would leak the message.
    const err = Object.assign(new Error('new row violates check constraint'), {
      code: '23514',
      detail: `Failing row contains (${SECRET_BODY}).`,
    });
    state.insertError = err;
    expectEmptyTwiml(await text());
    const line = logLines.find((l) => l.includes('inbound_sms_store_failed'));
    expect(line).toBeDefined();
    expect(line).toContain(SID_1);
    expect(line).toContain('23514');
    expect(line).not.toContain(SECRET_BODY);
  });

  it('never writes the message body to the log — stored, unknown number, or failed insert', async () => {
    await text();
    state.owned = null;
    await text({ MessageSid: SID_2 });
    expect(logLines.join('\n')).not.toContain(SECRET_BODY);
    state.owned = OWNED();
    state.insertError = Object.assign(new Error('boom'), { detail: SECRET_BODY });
    await text({ MessageSid: SID_2 });
    expect(logLines.some((l) => l.includes('inbound_sms_store_failed'))).toBe(true);
    expect(logLines.join('\n')).not.toContain(SECRET_BODY);
  });
});

describe('POST /telephony/twilio/sms — who gets it', () => {
  it('an agent number routes to its assigned rep without consulting the pool rules', async () => {
    await text();
    expect(state.rows.get(SID_1)).toMatchObject({ userId: 'rep-1', status: 'pending' });
    expect(state.stickyAgentForCaller).not.toHaveBeenCalled();
    expect(state.lastDialerForCaller).not.toHaveBeenCalled();
  });

  it('an unassigned agent (reserve) number stores the text as skipped, routed to nobody', async () => {
    state.owned = OWNED({ assignedUserId: null });
    expectEmptyTwiml(await text());
    expect(state.rows.get(SID_1)).toMatchObject({ userId: null, status: 'skipped' });
  });

  it('a pool number routes to the sticky rep FIRST — the last dialer is not even asked', async () => {
    state.owned = OWNED({ kind: 'dialer_pool', assignedUserId: null });
    state.stickyAgentId = 'rep-sticky';
    state.lastDialerId = 'rep-dialer';
    await text();
    expect(state.rows.get(SID_1)).toMatchObject({ userId: 'rep-sticky', status: 'pending' });
    expect(state.stickyAgentForCaller).toHaveBeenCalledWith(expect.anything(), 'org-1', '+13105550002', '+16195550100');
    expect(state.lastDialerForCaller).not.toHaveBeenCalled();
  });

  it('a pool number with no sticky routes to the rep who last dialed the sender', async () => {
    state.owned = OWNED({ kind: 'dialer_pool', assignedUserId: null });
    state.lastDialerId = 'rep-dialer';
    await text();
    expect(state.rows.get(SID_1)).toMatchObject({ userId: 'rep-dialer', status: 'pending' });
    expect(state.lastDialerForCaller).toHaveBeenCalledWith(expect.anything(), 'org-1', '+13105550002', '+16195550100');
  });

  it('a pool number nobody is tied to is stored as skipped', async () => {
    state.owned = OWNED({ kind: 'dialer_pool', assignedUserId: null });
    expectEmptyTwiml(await text());
    expect(state.rows.get(SID_1)).toMatchObject({ userId: null, status: 'skipped' });
  });

  it('a routing lookup error degrades to the next rule, then to nobody — never a lost 200', async () => {
    state.owned = OWNED({ kind: 'dialer_pool', assignedUserId: null });
    state.stickyError = new Error('db hiccup');
    state.lastDialerId = 'rep-dialer';
    expectEmptyTwiml(await text());
    expect(state.rows.get(SID_1)).toMatchObject({ userId: 'rep-dialer', status: 'pending' });

    state.lastDialerError = new Error('db hiccup');
    expectEmptyTwiml(await text({ MessageSid: SID_2 }));
    expect(state.rows.get(SID_2)).toMatchObject({ userId: null, status: 'skipped' });
    expect(logLines.some((l) => l.includes('inbound_sms_route_lookup_failed'))).toBe(true);
  });
});

describe('insertInboundMessage — the emitted SQL', () => {
  it('is a bare ON CONFLICT DO NOTHING (arbitrates on the message_sid unique index, never a named target)', () => {
    const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });
    const { sql } = insertInboundMessage(db, {
      orgId: '11111111-1111-1111-1111-111111111111',
      messageSid: SID_1,
      fromE164: '+13105550002',
      toE164: '+16195550100',
      body: 'x',
      numMedia: 0,
      userId: null,
      status: 'skipped',
    }).toSQL();
    expect(sql).toMatch(/^insert into "inbound_messages" /);
    expect(sql).toMatch(/on conflict do nothing returning "id"$/);
    expect(sql).not.toMatch(/on conflict \(/);
  });
});
