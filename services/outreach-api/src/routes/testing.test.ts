/**
 * The Testing page's routes (plan docs/superpowers/plans/2026-10-16-inbound-agent-testing.md, Task 3): the admin's list of test
 * phones (add, list, remove) and the recent inbound test calls with the AI numbers to dial. The list is real Postgres
 * (set TEST_DATABASE_URL, see test/pg.ts): the contract is about what `ai_test_phones` holds, per org, and what the listing
 * reads of `ai_calls` rows that cti-api wrote.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  INBOUND_TEST_CALLS_SHOWN,
  InboundTestCallsResponse,
  TEST_PHONES_MAX,
  TestPhone,
  TestPhonesResponse,
} from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { buildApp } from '../app.js';
import { fakeDb, testConfig } from '../test/harness.js';
import { seedAiCall } from '../test/ai-call-seed.js';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { seedOrg } from '../test/outreach-fixtures.js';
import { registerTestingRoutes } from './testing.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));

const auth = { authorization: 'Bearer t' };
const PHONES = '/api/testing/phones';
const INBOUND = '/api/testing/inbound-calls';

let app: FastifyInstance | undefined;
let lines: string[] = [];
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const send = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  app!.inject({ method, url, headers: auth, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
const sessionOf = (orgId: string, userId: string, isAdmin = true) => ({ userId, orgId, email: 'admin@gg.co', isAdmin, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false });

async function buildWith(db: Db) {
  lines = [];
  app = await buildApp({
    cfg: testConfig({ NODE_ENV: 'development' }),
    readiness: async () => ({ dbOk: true, jobsOk: true }),
    logStream: { write: (line) => lines.push(line) },
    apiRoutes: [(scope) => registerTestingRoutes(scope, { db })],
  });
}

describe('testing routes, who may call them (no database needed)', () => {
  const ORG = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null, settings: {} };
  const ID = randomUUID();
  const routes = [
    ['GET', PHONES, undefined],
    ['POST', PHONES, { phone: '(619) 555-0123' }],
    ['DELETE', `${PHONES}/${ID}`, undefined],
    ['GET', INBOUND, undefined],
  ] as const;

  it('401 without a session; 403 ADMIN_ONLY for a non-admin on every route', async () => {
    await buildWith(fakeDb({ organizations: [ORG] }).db);
    state.session = null;
    for (const [method, url, body] of routes) expect((await send(method, url, body)).statusCode, `${method} ${url}`).toBe(401);
    state.session = sessionOf('O1', 'U-REP', false);
    for (const [method, url, body] of routes) {
      const res = await send(method, url, body);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().code).toBe('ADMIN_ONLY');
    }
  });
});

describe.skipIf(!pgLane)('testing routes (real Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(() => {
    state.session = null;
  });

  /** A fresh org with an admin who exists in users (added_by is a foreign key), signed in. */
  async function signedInAdmin(email = 'admin@gg.co') {
    const orgId = await seedOrg(t.db);
    const [user] = await t.db.insert(schema.users).values({ orgId, email, isAdmin: true }).returning({ id: schema.users.id });
    state.session = sessionOf(orgId, user!.id);
    await buildWith(t.db);
    return { orgId, userId: user!.id };
  }
  const phoneRows = (orgId: string) => t.db.select().from(schema.aiTestPhones).where(eq(schema.aiTestPhones.orgId, orgId));
  const listed = async () => TestPhonesResponse.parse((await send('GET', PHONES)).json()).phones;
  const addRow = (orgId: string, userId: string, e164: string, label = '', createdAt?: Date) =>
    t.db.insert(schema.aiTestPhones).values({ orgId, e164, label, addedBy: userId, ...(createdAt ? { createdAt } : {}) });

  describe('GET /testing/phones', () => {
    it('a fresh org has none', async () => {
      await signedInAdmin();
      const res = await send('GET', PHONES);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ phones: [] });
    });

    it('lists the org\'s phones oldest first, with the label and the email of the admin who added each', async () => {
      const { orgId, userId } = await signedInAdmin('grant@gg.co');
      const [other] = await t.db.insert(schema.users).values({ orgId, email: 'sam@gg.co' }).returning({ id: schema.users.id });
      const start = Date.parse('2026-10-16T12:00:00.000Z');
      await addRow(orgId, other!.id, '+16195550102', 'Sam', new Date(start + 60_000));
      await addRow(orgId, userId, '+16195550101', 'Grant cell', new Date(start));
      const res = await send('GET', PHONES);
      expect(res.statusCode).toBe(200);
      const body = TestPhonesResponse.parse(res.json());
      expect(body.phones.map((p) => p.e164)).toEqual(['+16195550101', '+16195550102']);
      expect(body.phones[0]).toMatchObject({ label: 'Grant cell', addedByEmail: 'grant@gg.co', createdAt: new Date(start).toISOString() });
      expect(body.phones[1]).toMatchObject({ label: 'Sam', addedByEmail: 'sam@gg.co' });
    });

    it("is org-scoped: another org's phones are never listed", async () => {
      const a = await signedInAdmin('a@gg.co');
      await addRow(a.orgId, a.userId, '+16195550101', 'Org A');
      const b = await signedInAdmin('b@gg.co');
      await addRow(b.orgId, b.userId, '+16195550102', 'Org B');
      const phones = await listed();
      expect(phones.map((p) => p.label)).toEqual(['Org B']);
    });
  });

  describe('POST /testing/phones', () => {
    it('turns what was typed into E.164, stores it for the admin and answers 201 with the phone', async () => {
      const { orgId, userId } = await signedInAdmin('grant@gg.co');
      const res = await send('POST', PHONES, { phone: '(619) 555-0123', label: '  Grant cell  ' });
      expect(res.statusCode).toBe(201);
      const phone = TestPhone.parse(res.json());
      expect(phone).toMatchObject({ e164: '+16195550123', label: 'Grant cell', addedByEmail: 'grant@gg.co' });
      expect(await phoneRows(orgId)).toEqual([expect.objectContaining({ id: phone.id, orgId, e164: '+16195550123', label: 'Grant cell', addedBy: userId })]);
      expect(await listed()).toEqual([phone]);
    });

    it('the label is optional (stored as an empty string)', async () => {
      const { orgId } = await signedInAdmin();
      const res = await send('POST', PHONES, { phone: '+1 619 555 0124' });
      expect(res.statusCode).toBe(201);
      expect((await phoneRows(orgId)).map((r) => [r.e164, r.label])).toEqual([['+16195550124', '']]);
    });

    it.each([
      ['letters', { phone: 'call me' }],
      ['too short', { phone: '555' }],
      ['not a valid number', { phone: '000 000 0000' }],
      ['an empty phone', { phone: '   ' }],
      ['no phone at all', { label: 'Grant' }],
      ['a phone that is not text', { phone: 6195550123 }],
      ['no body at all', undefined],
    ])('%s is 400 "That doesn\'t look like a phone number" and nothing is stored', async (_label, payload) => {
      const { orgId } = await signedInAdmin();
      const res = await send('POST', PHONES, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "That doesn't look like a phone number", code: 'INVALID_PHONE' });
      expect(await phoneRows(orgId)).toEqual([]);
    });

    it('a label over 60 characters is 400 with its own sentence, and nothing is stored', async () => {
      const { orgId } = await signedInAdmin();
      const res = await send('POST', PHONES, { phone: '(619) 555-0123', label: 'x'.repeat(61) });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'Keep the label to 60 characters or fewer', code: 'INVALID_LABEL' });
      expect(await phoneRows(orgId)).toEqual([]);
    });

    it('the same phone twice is 409, however it is typed, and the first stays as it was', async () => {
      const { orgId } = await signedInAdmin();
      expect((await send('POST', PHONES, { phone: '(619) 555-0123', label: 'First' })).statusCode).toBe(201);
      for (const again of ['(619) 555-0123', '619-555-0123', '+16195550123', '1 619 555 0123']) {
        const res = await send('POST', PHONES, { phone: again, label: 'Second' });
        expect(res.statusCode, again).toBe(409);
        expect(res.json()).toMatchObject({ error: 'That phone is already on the list', code: 'PHONE_ALREADY_LISTED' });
      }
      expect((await phoneRows(orgId)).map((r) => [r.e164, r.label])).toEqual([['+16195550123', 'First']]);
    });

    it('the same phone may be on two orgs\' lists', async () => {
      await signedInAdmin('a@gg.co');
      expect((await send('POST', PHONES, { phone: '(619) 555-0123' })).statusCode).toBe(201);
      await signedInAdmin('b@gg.co');
      expect((await send('POST', PHONES, { phone: '(619) 555-0123' })).statusCode).toBe(201);
    });

    it('a 26th phone is 400 "The list is full", and removing one makes room again', async () => {
      const { orgId, userId } = await signedInAdmin();
      const numbers = Array.from({ length: TEST_PHONES_MAX }, (_, i) => `+1619555${String(1000 + i)}`);
      await t.db.insert(schema.aiTestPhones).values(numbers.map((e164) => ({ orgId, e164, addedBy: userId })));
      const full = await send('POST', PHONES, { phone: '(619) 555-0199' });
      expect(full.statusCode).toBe(400);
      expect(full.json()).toMatchObject({ error: 'The list is full (25 phones) — remove one first', code: 'LIST_FULL' });
      expect(await phoneRows(orgId)).toHaveLength(TEST_PHONES_MAX);

      // A phone that is already there is still reported as already there, not as a full list.
      expect((await send('POST', PHONES, { phone: numbers[3]! })).statusCode).toBe(409);

      const [first] = await listed();
      expect((await send('DELETE', `${PHONES}/${first!.id}`)).statusCode).toBe(204);
      expect((await send('POST', PHONES, { phone: '(619) 555-0199' })).statusCode).toBe(201);
      expect(await phoneRows(orgId)).toHaveLength(TEST_PHONES_MAX);
    });

    it("another org's full list does not fill this one", async () => {
      const a = await signedInAdmin('a@gg.co');
      await t.db.insert(schema.aiTestPhones).values(Array.from({ length: TEST_PHONES_MAX }, (_, i) => ({ orgId: a.orgId, e164: `+1619555${String(2000 + i)}`, addedBy: a.userId })));
      await signedInAdmin('b@gg.co');
      expect((await send('POST', PHONES, { phone: '(619) 555-0199' })).statusCode).toBe(201);
    });

    it('two adds at once never take the list past its limit', async () => {
      const { orgId, userId } = await signedInAdmin();
      await t.db.insert(schema.aiTestPhones).values(Array.from({ length: TEST_PHONES_MAX - 1 }, (_, i) => ({ orgId, e164: `+1619555${String(3000 + i)}`, addedBy: userId })));
      const results = await Promise.all(['(619) 555-0191', '(619) 555-0192', '(619) 555-0193'].map((phone) => send('POST', PHONES, { phone })));
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 400, 400]);
      expect(await phoneRows(orgId)).toHaveLength(TEST_PHONES_MAX);
    });

    it('never logs a phone number or a label', async () => {
      await signedInAdmin();
      await send('POST', PHONES, { phone: '(619) 555-0123', label: 'SECRETLABEL' });
      await send('POST', PHONES, { phone: '(619) 555-0123', label: 'SECRETLABEL' });
      await send('POST', PHONES, { phone: 'SECRETLABEL' });
      const logged = lines.join('\n');
      expect(logged).not.toContain('SECRETLABEL');
      expect(logged).not.toContain('5550123');
    });
  });

  describe('DELETE /testing/phones/:id', () => {
    it('removes the phone and answers 204; the rest stay', async () => {
      const { orgId, userId } = await signedInAdmin();
      await addRow(orgId, userId, '+16195550101', 'Keep');
      await addRow(orgId, userId, '+16195550102', 'Drop');
      const drop = (await listed()).find((p) => p.label === 'Drop')!;
      const res = await send('DELETE', `${PHONES}/${drop.id}`);
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expect((await phoneRows(orgId)).map((r) => r.label)).toEqual(['Keep']);
    });

    it("is 404 for an unknown id, a non-UUID, and another org's phone (which stays)", async () => {
      const theirs = await signedInAdmin('other@gg.co');
      await addRow(theirs.orgId, theirs.userId, '+16195550101', 'Theirs');
      const [theirPhone] = await phoneRows(theirs.orgId);
      const mine = await signedInAdmin('mine@gg.co');
      for (const id of [randomUUID(), 'not-an-id', theirPhone!.id]) {
        const res = await send('DELETE', `${PHONES}/${id}`);
        expect(res.statusCode, id).toBe(404);
        expect(res.json().code).toBe('NOT_FOUND');
      }
      expect(await phoneRows(theirs.orgId)).toHaveLength(1);
      expect(await phoneRows(mine.orgId)).toEqual([]);
    });

    it('removing a phone leaves its earlier calls in the listing (the label is gone, the number stays)', async () => {
      const { orgId, userId } = await signedInAdmin();
      await addRow(orgId, userId, '+16195550101', 'Grant cell');
      await seedAiCall(t.db, orgId, userId, { direction: 'inbound', isTest: true, toE164: '+16195550101', fromE164: '+16195550900', status: 'completed' });
      const [phone] = await listed();
      expect((await send('DELETE', `${PHONES}/${phone!.id}`)).statusCode).toBe(204);
      const { calls } = InboundTestCallsResponse.parse((await send('GET', INBOUND)).json());
      expect(calls).toEqual([expect.objectContaining({ callerE164: '+16195550101', callerLabel: null })]);
    });
  });

  describe('GET /testing/inbound-calls', () => {
    const number = (orgId: string, e164: string, over: Partial<typeof schema.outboundNumbers.$inferInsert> = {}) =>
      t.db.insert(schema.outboundNumbers).values({ orgId, e164, provider: 'twilio', kind: 'ai_pool', inboundEnabled: true, ...over });

    it('a fresh org: no numbers and no calls', async () => {
      await signedInAdmin();
      const res = await send('GET', INBOUND);
      expect(res.statusCode).toBe(200);
      expect(InboundTestCallsResponse.parse(res.json())).toEqual({ aiNumbers: [], calls: [] });
    });

    it("the AI numbers are the org's ai_pool numbers that take inbound calls, by number; no agent, dialer-pool, inbound-off or other-org number", async () => {
      const { orgId } = await signedInAdmin();
      await number(orgId, '+16195550902');
      await number(orgId, '+16195550901');
      await number(orgId, '+16195550903', { inboundEnabled: false });
      await number(orgId, '+16195550904', { kind: 'agent' });
      await number(orgId, '+16195550905', { kind: 'dialer_pool' });
      const other = await seedOrg(t.db);
      await number(other, '+16195550906');
      const body = InboundTestCallsResponse.parse((await send('GET', INBOUND)).json());
      expect(body.aiNumbers).toEqual(['+16195550901', '+16195550902']);
    });

    it('lists an inbound call with the caller\'s label from the list, the number dialed, its status and duration', async () => {
      const { orgId, userId } = await signedInAdmin();
      await addRow(orgId, userId, '+16195550101', 'Grant cell');
      const startedAt = new Date('2026-10-16T18:30:00.000Z');
      const id = await seedAiCall(t.db, orgId, userId, {
        direction: 'inbound', isTest: true, toE164: '+16195550101', fromE164: '+16195550900', status: 'completed', outcome: 'qualified',
        startedAt, durationSeconds: 95, qualification: { status: 'qualified', location: '12 Oak St, Escondido', timeline: 'next month', notes: 'Wants a quick close' },
      });
      const { calls } = InboundTestCallsResponse.parse((await send('GET', INBOUND)).json());
      expect(calls).toEqual([
        {
          id, callerE164: '+16195550101', callerLabel: 'Grant cell', aiNumber: '+16195550900', status: 'completed', outcome: 'qualified',
          startedAt: startedAt.toISOString(), durationSeconds: 95,
          details: { status: 'qualified', location: '12 Oak St, Escondido', timeline: 'next month', notes: 'Wants a quick close' },
        },
      ]);
    });

    it('a caller no longer on the list has no label; a call in progress has no outcome or duration yet', async () => {
      const { orgId, userId } = await signedInAdmin();
      await seedAiCall(t.db, orgId, userId, { direction: 'inbound', isTest: true, toE164: '+16195550177', fromE164: null, status: 'in_progress', startedAt: new Date() });
      const { calls } = InboundTestCallsResponse.parse((await send('GET', INBOUND)).json());
      expect(calls[0]).toMatchObject({ callerE164: '+16195550177', callerLabel: null, aiNumber: null, status: 'in_progress', outcome: null, durationSeconds: null, details: {} });
    });

    it("the label comes from this org's list only (another org's label for the same number is not used)", async () => {
      const other = await signedInAdmin('other@gg.co');
      await addRow(other.orgId, other.userId, '+16195550101', 'Their label');
      const mine = await signedInAdmin('mine@gg.co');
      await seedAiCall(t.db, mine.orgId, mine.userId, { direction: 'inbound', isTest: true, toE164: '+16195550101', status: 'completed' });
      const { calls } = InboundTestCallsResponse.parse((await send('GET', INBOUND)).json());
      expect(calls.map((c) => c.callerLabel)).toEqual([null]);
    });

    it('details: unknown keys are dropped; a row that does not parse (bad status, not an object, not JSON object) reads as {}', async () => {
      const { orgId, userId } = await signedInAdmin();
      const make = (qualification: unknown, startedAt: string) =>
        seedAiCall(t.db, orgId, userId, { direction: 'inbound', isTest: true, toE164: '+16195550101', status: 'completed', startedAt: new Date(startedAt), qualification });
      const keys = await make({ location: 'Escondido', legacy_key: 'x', status: 'callback' }, '2026-10-16T10:00:00.000Z');
      const badStatus = await make({ status: 'maybe', location: 'Escondido' }, '2026-10-16T11:00:00.000Z');
      const notObject = await make(['a', 'b'], '2026-10-16T12:00:00.000Z');
      const wrongType = await make({ location: 42 }, '2026-10-16T13:00:00.000Z');
      const { calls } = InboundTestCallsResponse.parse((await send('GET', INBOUND)).json());
      const detailsOf = (id: string) => calls.find((c) => c.id === id)!.details;
      expect(detailsOf(keys)).toEqual({ status: 'callback', location: 'Escondido' });
      expect(detailsOf(badStatus)).toEqual({});
      expect(detailsOf(notObject)).toEqual({});
      expect(detailsOf(wrongType)).toEqual({});
    });

    it('shows at most the newest 20, newest first', async () => {
      const { orgId, userId } = await signedInAdmin();
      const start = Date.parse('2026-10-16T08:00:00.000Z');
      for (let i = 0; i < INBOUND_TEST_CALLS_SHOWN + 5; i += 1) {
        await seedAiCall(t.db, orgId, userId, {
          direction: 'inbound', isTest: true, toE164: '+16195550101', status: 'completed', startedAt: new Date(start + i * 60_000), createdAt: new Date(start + i * 60_000), durationSeconds: i,
        });
      }
      const { calls } = InboundTestCallsResponse.parse((await send('GET', INBOUND)).json());
      expect(calls).toHaveLength(INBOUND_TEST_CALLS_SHOWN);
      expect(calls.map((c) => c.durationSeconds)).toEqual(Array.from({ length: INBOUND_TEST_CALLS_SHOWN }, (_, i) => INBOUND_TEST_CALLS_SHOWN + 4 - i));
    });

    it("lists only inbound calls of this org: not outbound or test calls, not another org's", async () => {
      const mine = await signedInAdmin('mine@gg.co');
      const inbound = await seedAiCall(t.db, mine.orgId, mine.userId, { direction: 'inbound', isTest: true, toE164: '+16195550101', status: 'completed' });
      await seedAiCall(t.db, mine.orgId, mine.userId, { isTest: true, toE164: '+16195550101', status: 'completed' });
      await seedAiCall(t.db, mine.orgId, mine.userId, { toE164: '+16195550101', status: 'completed' });
      const other = await seedOrg(t.db);
      const [stranger] = await t.db.insert(schema.users).values({ orgId: other, email: 'x@other.co' }).returning({ id: schema.users.id });
      await seedAiCall(t.db, other, stranger!.id, { direction: 'inbound', isTest: true, toE164: '+16195550101', status: 'completed' });
      const { calls } = InboundTestCallsResponse.parse((await send('GET', INBOUND)).json());
      expect(calls.map((c) => c.id)).toEqual([inbound]);
    });

    it('never puts the transcript or the summary in the listing', async () => {
      const { orgId, userId } = await signedInAdmin();
      await seedAiCall(t.db, orgId, userId, {
        direction: 'inbound', isTest: true, toE164: '+16195550101', status: 'completed', summary: 'SECRETSUMMARY', transcript: [{ role: 'caller', text: 'SECRETWORDS', at: null }],
      });
      const res = await send('GET', INBOUND);
      expect(res.body).not.toContain('SECRETSUMMARY');
      expect(res.body).not.toContain('SECRETWORDS');
    });
  });
});
