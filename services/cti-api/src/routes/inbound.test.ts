/**
 * POST /telephony/twilio/inbound — Salesforce-caller-match parameters on the
 * ringing `<Dial><Client>`.
 *
 * The API already matches the inbound caller against Salesforce (`matched`)
 * and uses it for the voicemail greeting + Task attachment; this proves that
 * match also reaches the CLIENT via Twilio custom parameters on BOTH ring
 * paths — the dialer-pool sticky-agent branch and the assigned-rep branch —
 * so the ringing softphone can show a name and screen-pop on accept.
 *
 * Route-level (Fastify + fake-DB injection), following
 * calls-disposition.test.ts: the wiring — which TwiML the caller-match
 * produces — is the thing under test. `where` clauses are never introspected
 * (the package-wide fake-DB convention); each fixture is looked up by table.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  owned: null as Record<string, unknown> | null,
  repRow: null as Record<string, unknown> | null,
  sfConn: null as Record<string, unknown> | null,
  stickyAgentId: null as string | null,
  findByPhoneResult: null as { whoId?: string; whatId?: string; name?: string } | null,
  findByPhone: vi.fn(async (_userId: string, _e164: string) => state.findByPhoneResult),
  stickyAgentForCaller: vi.fn(async () => state.stickyAgentId),
  /** Inserts attempted into `calls` (other tables are not counted). */
  inserts: 0,
  // Simulates a replayed delivery: the call row already exists, the insert's
  // ON CONFLICT DO NOTHING returns no row, and the handler must reuse this one.
  duplicateInsert: false,
  existingCall: null as Record<string, unknown> | null,
}));

vi.mock('../config.js', () => ({
  loadConfig: () => ({
    API_PUBLIC_URL: 'https://api.example.com',
    TELEPHONY_PROVIDER: 'twilio',
    TWILIO_SKIP_SIGNATURE_CHECK: true,
    TWILIO_RECORD_CALLS: false,
    TWILIO_AUTH_TOKEN: undefined,
  }),
}));

vi.mock('../salesforce/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../salesforce/client.js')>();
  return { ...actual, findByPhone: state.findByPhone };
});

vi.mock('../dialer/sticky.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dialer/sticky.js')>();
  return { ...actual, stickyAgentForCaller: state.stickyAgentForCaller };
});

vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return { ...actual, getDb: () => fakeDb() };
});

import { schema } from '@cti/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { insertInboundCall, registerInboundRoutes } from './inbound.js';

/** Just enough drizzle for the inbound-ring handler. */
function fakeDb() {
  return {
    query: {
      outboundNumbers: { findFirst: async () => state.owned },
      users: { findFirst: async () => state.repRow },
      salesforceConnections: { findFirst: async () => state.sfConn },
      calls: { findFirst: async () => state.existingCall },
    },
    insert(table: unknown) {
      if (table === schema.calls) state.inserts++; // only the call row matters to these tests
      return {
        values(v: Record<string, unknown>) {
          const returning = async () => (state.duplicateInsert ? [] : [{ id: 'call-db-1', ...v }]);
          return { returning, onConflictDoNothing: () => ({ returning }) };
        },
      };
    },
    update(_table: unknown) {
      return {
        set(_values: Record<string, unknown>) {
          return { where: async () => {} };
        },
      };
    },
  } as unknown as ReturnType<typeof import('@cti/db').getDb>;
}

const OWNED = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'num-1',
  orgId: 'org-1',
  e164: '+16195550100',
  provider: 'twilio',
  kind: 'agent',
  inboundEnabled: true,
  inboundGreeting: null,
  inboundMatchedGreeting: null,
  inboundRecordSeconds: 60,
  inboundTranscribe: false,
  inboundForwardToE164: null,
  assignedUserId: 'rep-1',
  ...over,
});

let app: FastifyInstance;

beforeEach(async () => {
  state.owned = OWNED();
  state.repRow = { id: 'rep-1', noAnswerForwardE164: null };
  state.sfConn = { userId: 'rep-1' };
  state.stickyAgentId = null;
  state.findByPhoneResult = null;
  state.findByPhone.mockClear();
  state.stickyAgentForCaller.mockClear();
  state.inserts = 0;
  state.duplicateInsert = false;
  state.existingCall = null;
  app = Fastify();
  // Mirror server.ts's raw-body capturing parser — inbound.ts reads
  // `req.rawBody` for webhook signature validation.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, body, done) => {
      (req as unknown as { rawBody?: string }).rawBody = body as string;
      const params: Record<string, string> = {};
      new URLSearchParams(body as string).forEach((v, k) => {
        params[k] = v;
      });
      done(null, params);
    },
  );
  await registerInboundRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function ring(overrides: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/telephony/twilio/inbound',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: {
      From: '+13105550002',
      To: '+16195550100',
      CallSid: 'CA_test_1',
      ...overrides,
    },
  });
}

describe('POST /telephony/twilio/inbound — caller-match parameters on <Client>', () => {
  describe('assigned-rep ring path (owned.assignedUserId)', () => {
    it('matched caller (Lead) → TwiML carries callerName, recordId, recordType inside <Client><Identity>', async () => {
      state.findByPhoneResult = { whoId: '00Q000000000001AAA', name: 'Jane Doe' };

      const res = await ring();
      const xml = res.body;

      expect(res.statusCode).toBe(200);
      // Exact nesting: Twilio only documents custom parameters alongside the
      // `<Identity>` noun, never mixed with `<Client>` text content — pin the
      // whole element so a regression to the undocumented shape fails here.
      expect(xml).toContain(
        '<Client><Identity>rep_rep1</Identity>' +
          '<Parameter name="callerName" value="Jane Doe"/>' +
          '<Parameter name="recordId" value="00Q000000000001AAA"/>' +
          '<Parameter name="recordType" value="Lead"/></Client>',
      );
    });

    it('a whatId-only Deal match → recordId is the whatId and recordType is the honest "Record" fallback', async () => {
      state.findByPhoneResult = { whatId: 'a0X000000000009AAA', name: 'Acme Deal' };

      const res = await ring();
      const xml = res.body;

      expect(xml).toContain('<Parameter name="recordId" value="a0X000000000009AAA"/>');
      expect(xml).toContain('<Parameter name="recordType" value="Record"/>');
    });

    it('unmatched caller → exact <Client>rep_rep1</Client>, no <Identity>, no <Parameter> — identical TwiML to before this feature', async () => {
      state.findByPhoneResult = null;

      const res = await ring();
      const xml = res.body;

      expect(xml).toContain('<Client>rep_rep1</Client>');
      expect(xml).not.toContain('<Identity');
      expect(xml).not.toContain('<Parameter');
    });
  });

  describe('dialer-pool sticky-agent ring path (owned.kind === "dialer_pool")', () => {
    beforeEach(() => {
      state.owned = OWNED({ kind: 'dialer_pool', assignedUserId: null });
      state.stickyAgentId = 'rep-2';
      state.repRow = { id: 'rep-2', noAnswerForwardE164: null };
      state.sfConn = { userId: 'rep-2' };
    });

    it('matched caller (Lead) → TwiML carries callerName, recordId, recordType inside <Client><Identity>', async () => {
      state.findByPhoneResult = { whoId: '00Q000000000002BBB', name: 'John Roe' };

      const res = await ring();
      const xml = res.body;

      expect(xml).toContain(
        '<Client><Identity>rep_rep2</Identity>' +
          '<Parameter name="callerName" value="John Roe"/>' +
          '<Parameter name="recordId" value="00Q000000000002BBB"/>' +
          '<Parameter name="recordType" value="Lead"/></Client>',
      );
    });

    it('unmatched caller → exact <Client>rep_rep2</Client>, no <Identity>, no <Parameter> on the pool ring path either', async () => {
      state.findByPhoneResult = null;

      const res = await ring();
      const xml = res.body;

      expect(xml).toContain('<Client>rep_rep2</Client>');
      expect(xml).not.toContain('<Identity');
      expect(xml).not.toContain('<Parameter');
    });
  });

  describe('voicemail branch — untouched by this feature', () => {
    it('an unassigned reserve number (no rep to ring) still goes straight to voicemail, with no <Client>/<Parameter> at all', async () => {
      state.owned = OWNED({ assignedUserId: null, kind: 'agent' });
      state.findByPhoneResult = { whoId: '00Q000000000003CCC', name: 'Voicemail Vic' };

      const res = await ring();
      const xml = res.body;

      expect(xml).not.toContain('<Client');
      expect(xml).not.toContain('<Parameter');
      expect(xml).toContain('<Record');
      expect(xml).toContain('Hi Voicemail, thanks for calling back');
    });
  });
});

describe('voicemail <Record> hands control to its own action route', () => {
  // Without an action, Twilio re-requests the CURRENT document when a
  // recording ends with the caller still on the line — POST /inbound again for
  // the same CallSid — which re-inserted the call, hit the unique index, and
  // 500ed (Twilio alert 11200 on 2026-09-10 and 09-11). The caller heard an
  // application error instead of a goodbye.
  it('the voicemail TwiML carries a POST action on <Record>, scoped to this call', async () => {
    state.owned = OWNED({ assignedUserId: null, kind: 'agent' });
    const xml = (await ring()).body;
    expect(xml).toMatch(/<Record[^>]*action="https:\/\/api\.example\.com\/telephony\/twilio\/inbound\/voicemail-done\?callDbId=call-db-1"/);
    expect(xml).toMatch(/<Record[^>]*method="POST"/);
    // The goodbye also stays after <Record> as an inert fallthrough — unreachable
    // when the action fires, a safety net if Twilio ever continues in-document.
    expect(xml).toContain('your message has been received');
  });

  it('POST /telephony/twilio/inbound/voicemail-done thanks the caller and hangs up, and never inserts a call row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/telephony/twilio/inbound/voicemail-done?callDbId=11111111-1111-1111-1111-111111111111',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: { CallSid: 'CA_test_1', RecordingUrl: 'https://api.twilio.com/rec/RE1', RecordingDuration: '11' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.body).toContain('Thanks, your message has been received. Goodbye.');
    expect(res.body).toContain('<Hangup/>');
    expect(state.inserts).toBe(0);
  });
});

describe('POST /telephony/twilio/inbound — a replayed delivery of the same CallSid', () => {
  it('answers with the ring TwiML for the EXISTING call row instead of 500ing on the unique index', async () => {
    state.duplicateInsert = true;
    state.existingCall = { id: 'call-db-existing' };
    const res = await ring();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.body).toContain('callDbId=call-db-existing');
    expect(res.body).not.toContain('callDbId=call-db-1');
    expect(state.inserts).toBe(1);
  });
});

describe('POST /telephony/twilio/inbound/dial-result — no-answer fallback to voicemail', () => {
  it('the fallback voicemail <Record> carries the action too (this path used to re-enter dial-result silently)', async () => {
    const id = '22222222-2222-2222-2222-222222222222';
    state.existingCall = { id, userId: 'rep-1', normalizedToNumber: '+16195550100' };
    state.owned = OWNED({ inboundForwardToE164: null });
    state.repRow = { id: 'rep-1', noAnswerForwardE164: null };
    const res = await app.inject({
      method: 'POST',
      url: `/telephony/twilio/inbound/dial-result?callDbId=${id}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: { CallSid: 'CA_test_1', DialCallStatus: 'no-answer' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(new RegExp(`<Record[^>]*action="https://api\\.example\\.com/telephony/twilio/inbound/voicemail-done\\?callDbId=${id}"`));
  });
});

describe('insertInboundCall — the statement Postgres actually receives', () => {
  // The DB fake above cannot tell a usable ON CONFLICT clause from an unusable
  // one, and `calls_provider_call_id_unique` is a PARTIAL index: a targeted
  // `on conflict ("provider","provider_call_id")` makes Postgres reject the
  // insert outright (42P10) on every call. Pin the bare form, which arbitrates
  // on any constraint. No connection is opened — `pg.Pool` is lazy.
  it('emits a bare ON CONFLICT DO NOTHING (no column target, no predicate needed)', () => {
    const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });
    const { sql } = insertInboundCall(db, {
      orgId: '11111111-1111-1111-1111-111111111111',
      provider: 'twilio',
      providerCallId: 'CA_test_1',
      fromNumber: '+13105550002',
      toNumber: '+16195550100',
      normalizedToNumber: '+16195550100',
      direction: 'inbound',
      status: 'in_progress',
      startedAt: new Date(),
    } as never).toSQL();
    expect(sql).toMatch(/on conflict do nothing returning "id"$/);
    expect(sql).not.toMatch(/on conflict \(/);
  });
});
