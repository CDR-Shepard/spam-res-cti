/**
 * The Resend webhook route: the first public (no session) route under /api. What it must never do is store
 * a body it could not verify, store one twice, or take a seller's address anywhere near a log line.
 * The unit lane uses a stateful fake of the one insert the route makes; the real-Postgres block proves the
 * same on the actual table.
 */
import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { schema, type Db } from '@cti/db';
import { buildApp } from '../app.js';
import { testConfig } from '../test/harness.js';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { registerResendWebhookRoutes } from './resend-webhook.js';

const KEY = Buffer.from('a-test-signing-key-not-a-real-one');
const SECRET = `whsec_${KEY.toString('base64')}`;
const NOW = new Date('2026-10-20T12:00:00.000Z');
const TS = String(Math.floor(NOW.getTime() / 1000));
const SVIX_ID = 'msg_2abcDEF';
const BODY = JSON.stringify({
  type: 'email.delivered',
  created_at: '2026-10-20T11:59:58.000Z',
  data: { email_id: '11111111-2222-3333-4444-555555555555', to: ['delivered@resend.dev'] },
});

const sign = (id: string, ts: string, body: string): string => `v1,${createHmac('sha256', KEY).update(`${id}.${ts}.${body}`).digest('base64')}`;
const signedHeaders = (body: string = BODY, over: Record<string, unknown> = {}) => ({
  'content-type': 'application/json',
  'svix-id': SVIX_ID,
  'svix-timestamp': TS,
  'svix-signature': sign(SVIX_ID, TS, body),
  ...over,
});

interface StoredEvent {
  svixId: string;
  type: string;
  payload: unknown;
}

/** The one statement the route makes: insert into resend_webhook_events … on conflict do nothing. A plain insert of a duplicate throws, as the primary key would. */
function fakeEventsDb() {
  const rows = new Map<string, StoredEvent>();
  const db = {
    insert: (table: unknown) => {
      expect(table).toBe(schema.resendWebhookEvents);
      return {
        values: (v: StoredEvent) => ({
          onConflictDoNothing: async () => {
            if (!rows.has(v.svixId)) rows.set(v.svixId, v);
          },
          then: (resolve: (value: undefined) => void, reject: (reason: unknown) => void) => {
            if (rows.has(v.svixId)) return reject(new Error('duplicate key value violates unique constraint'));
            rows.set(v.svixId, v);
            return resolve(undefined);
          },
        }),
      };
    },
  };
  return { db: db as unknown as Db, rows };
}

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

async function build(db: Db, secret: string | null = SECRET) {
  app = await buildApp({
    cfg: testConfig(),
    readiness: async () => ({ dbOk: true, jobsOk: true }),
    apiRoutes: [(scope) => registerResendWebhookRoutes(scope, { db, secret, now: () => NOW })],
  });
  return app;
}

const post = (headers: Record<string, unknown>, payload: string) =>
  app.inject({ method: 'POST', url: '/api/webhooks/resend', headers: headers as Record<string, string>, payload });

describe('POST /api/webhooks/resend', () => {
  it('a correctly signed body answers 200 and stores one pending row under the svix id', async () => {
    const { db, rows } = fakeEventsDb();
    await build(db);
    const res = await post(signedHeaders(), BODY);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect([...rows.values()]).toEqual([{ svixId: SVIX_ID, type: 'email.delivered', payload: JSON.parse(BODY) }]);
  });

  it('needs no session: there is no cookie and no bearer token on the request', async () => {
    const { db } = fakeEventsDb();
    await build(db);
    expect((await post(signedHeaders(), BODY)).statusCode).toBe(200);
  });

  it('the same svix id again (an in-window replay or a redelivery) answers 200 and stores nothing new', async () => {
    const { db, rows } = fakeEventsDb();
    await build(db);
    expect((await post(signedHeaders(), BODY)).statusCode).toBe(200);
    const replay = await post(signedHeaders(), BODY);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ ok: true });
    expect(rows.size).toBe(1);
  });

  it('a tampered body is 401 BAD_SIGNATURE and stores nothing', async () => {
    const { db, rows } = fakeEventsDb();
    await build(db);
    const res = await post(signedHeaders(BODY), BODY.replace('email.delivered', 'email.bounced'));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'BAD_SIGNATURE' });
    expect(rows.size).toBe(0);
  });

  it.each(['svix-id', 'svix-timestamp', 'svix-signature'])('a missing %s header is 401 BAD_SIGNATURE', async (name) => {
    const { db, rows } = fakeEventsDb();
    await build(db);
    const headers: Record<string, unknown> = signedHeaders();
    delete headers[name];
    const res = await post(headers, BODY);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'BAD_SIGNATURE' });
    expect(rows.size).toBe(0);
  });

  it.each(['svix-id', 'svix-timestamp', 'svix-signature'])('%s as an array (Fastify types a header as string | string[]) is refused, not guessed at', async (name) => {
    const { db, rows } = fakeEventsDb();
    // Node joins repeated headers into one string, so an array is never what inject sends: put one on the request after parsing.
    app = await buildApp({
      cfg: testConfig(),
      readiness: async () => ({ dbOk: true, jobsOk: true }),
      apiRoutes: [
        async (scope) => {
          scope.addHook('onRequest', async (req) => {
            req.headers[name] = [req.headers[name] as string];
          });
          await registerResendWebhookRoutes(scope, { db, secret: SECRET, now: () => NOW });
        },
      ],
    });
    const res = await post(signedHeaders(), BODY);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'BAD_SIGNATURE' });
    expect(rows.size).toBe(0);
  });

  it('a signature made for another id, another timestamp or a stale timestamp is 401', async () => {
    const { db, rows } = fakeEventsDb();
    await build(db);
    expect((await post(signedHeaders(BODY, { 'svix-id': 'msg_other' }), BODY)).statusCode).toBe(401);
    expect((await post(signedHeaders(BODY, { 'svix-timestamp': String(Number(TS) + 1) }), BODY)).statusCode).toBe(401);
    const stale = String(Number(TS) - 301);
    expect((await post(signedHeaders(BODY, { 'svix-timestamp': stale, 'svix-signature': sign(SVIX_ID, stale, BODY) }), BODY)).statusCode).toBe(401);
    expect(rows.size).toBe(0);
  });

  it('answers 401 without saying which part was wrong', async () => {
    const { db } = fakeEventsDb();
    await build(db);
    const badSignature = await post(signedHeaders(BODY, { 'svix-signature': 'v1,AAAA' }), BODY);
    const noHeaders = await post({ 'content-type': 'application/json' }, BODY);
    const withoutRequestId = (res: { json: () => Record<string, unknown> }) => ({ ...res.json(), requestId: undefined });
    expect(withoutRequestId(badSignature)).toEqual(withoutRequestId(noHeaders));
  });

  it('no secret configured is 503 EMAIL_NOT_CONFIGURED, even for a request that carries a signature', async () => {
    const { db, rows } = fakeEventsDb();
    await build(db, null);
    const res = await post(signedHeaders(), BODY);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'EMAIL_NOT_CONFIGURED' });
    expect(rows.size).toBe(0);
  });

  it('a signed body that is not JSON is 400; an unsigned one is 401 first (nothing is parsed before it is verified)', async () => {
    const { db, rows } = fakeEventsDb();
    await build(db);
    const junk = 'this is { not json';
    expect((await post(signedHeaders(junk), junk)).statusCode).toBe(400);
    expect((await post({ ...signedHeaders(junk), 'svix-signature': 'v1,AAAA' }, junk)).statusCode).toBe(401);
    expect(rows.size).toBe(0);
  });

  it.each([['an array', '[]'], ['a string', '"email.delivered"'], ['no type', '{"data":{}}'], ['a blank type', '{"type":"  ","data":{}}'], ['a numeric type', '{"type":7}']])(
    'a signed body that is %s is 400: only an object with a type can be processed later',
    async (_name, body) => {
      const { db, rows } = fakeEventsDb();
      await build(db);
      expect((await post(signedHeaders(body), body)).statusCode).toBe(400);
      expect(rows.size).toBe(0);
    },
  );

  it('a body over 256 KB is 413 before anything is verified or stored', async () => {
    const { db, rows } = fakeEventsDb();
    await build(db);
    const big = JSON.stringify({ type: 'email.delivered', data: { padding: 'x'.repeat(256 * 1024) } });
    const res = await post(signedHeaders(big), big);
    expect(res.statusCode).toBe(413);
    expect(rows.size).toBe(0);
  });

  it('a body just under the limit is accepted', async () => {
    const { db, rows } = fakeEventsDb();
    await build(db);
    const nearly = JSON.stringify({ type: 'email.delivered', data: { padding: 'x'.repeat(200 * 1024) } });
    expect((await post(signedHeaders(nearly), nearly)).statusCode).toBe(200);
    expect(rows.size).toBe(1);
  });

  it('only application/json is read: any other content type is 415', async () => {
    const { db, rows } = fakeEventsDb();
    await build(db);
    const res = await post(signedHeaders(BODY, { 'content-type': 'text/plain' }), BODY);
    expect(res.statusCode).toBe(415);
    expect(rows.size).toBe(0);
  });

  it('the raw-body parser stays inside this route: another route keeps Fastify\'s JSON parsing', async () => {
    const { db } = fakeEventsDb();
    await build(db);
    // A sibling plugin registered after ours parses JSON the ordinary way (an object, not the raw string).
    await app.close();
    app = await buildApp({
      cfg: testConfig(),
      readiness: async () => ({ dbOk: true, jobsOk: true }),
      apiRoutes: [
        (scope) => registerResendWebhookRoutes(scope, { db, secret: SECRET, now: () => NOW }),
        async (scope) => {
          scope.post('/echo', async (req) => ({ isString: typeof req.body === 'string', body: req.body }));
        },
      ],
    });
    const res = await app.inject({ method: 'POST', url: '/api/echo', headers: { 'content-type': 'application/json' }, payload: '{"a":1}' });
    expect(res.json()).toEqual({ isString: false, body: { a: 1 } });
  });

  it('a failing insert is a 500 INTERNAL_ERROR, so Svix retries; nothing from the body is in the answer', async () => {
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: async () => {
            throw new Error('connection terminated: delivered@resend.dev');
          },
        }),
      }),
    } as unknown as Db;
    await build(db);
    const res = await post(signedHeaders(), BODY);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(res.body).not.toContain('resend.dev');
  });
});

describe.skipIf(!pgLane)('POST /api/webhooks/resend (real Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });

  it('stores the verified body as jsonb under the svix id; a redelivery leaves the one row untouched', async () => {
    await build(t.db);
    const id = 'msg_pg_replay';
    const headers = { ...signedHeaders(), 'svix-id': id, 'svix-signature': sign(id, TS, BODY) };
    expect((await post(headers, BODY)).statusCode).toBe(200);
    const first = await t.pool.query('select svix_id, type, payload, status, attempts, next_attempt_at <= now() as due from resend_webhook_events where svix_id = $1', [id]);
    expect(first.rows).toEqual([{ svix_id: id, type: 'email.delivered', payload: JSON.parse(BODY), status: 'pending', attempts: 0, due: true }]);

    await t.pool.query(`update resend_webhook_events set status = 'done' where svix_id = $1`, [id]);
    expect((await post(headers, BODY)).statusCode).toBe(200);
    const after = await t.pool.query('select status from resend_webhook_events where svix_id = $1', [id]);
    expect(after.rows).toEqual([{ status: 'done' }]); // a replay did not reset the processed row to pending
  });
});
