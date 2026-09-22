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

type LastDialerForCaller = typeof import('../dialer/sticky.js')['lastDialerForCaller'];

const state = vi.hoisted(() => ({
  owned: null as Record<string, unknown> | null,
  repRow: null as Record<string, unknown> | null,
  sfConn: null as Record<string, unknown> | null,
  stickyAgentId: null as string | null,
  /** What `lastDialerForCaller` answers — the rep who last power-dialed the caller. */
  lastDialerId: null as string | null,
  findByPhoneResult: null as { whoId?: string; whatId?: string; name?: string } | null,
  findByPhone: vi.fn(async (_userId: string, _e164: string) => state.findByPhoneResult),
  stickyAgentForCaller: vi.fn(async () => state.stickyAgentId),
  lastDialerForCaller: vi.fn(async (..._args: Parameters<LastDialerForCaller>) => state.lastDialerId),
  /** The un-mocked lookup, for the one test that needs its caller-shape guard. */
  realLastDialerForCaller: null as LastDialerForCaller | null,
  /** Inserts attempted into `calls` (other tables are not counted). */
  inserts: 0,
  /** The values of every `calls` insert, in order. */
  callValues: [] as Record<string, unknown>[],
  /** Any `db.select(...)` — the inbound handler never issues one itself. */
  selects: vi.fn(),
  // Simulates a replayed delivery: the call row already exists, the insert's
  // ON CONFLICT DO NOTHING returns no row, and the handler must reuse this one.
  duplicateInsert: false,
  existingCall: null as Record<string, unknown> | null,
  /** Every `update(...).set(patch)` a handler issued, in order. */
  updates: [] as Record<string, unknown>[],
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
  state.realLastDialerForCaller = actual.lastDialerForCaller;
  return {
    ...actual,
    stickyAgentForCaller: state.stickyAgentForCaller,
    lastDialerForCaller: state.lastDialerForCaller,
  };
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
      const isCall = table === schema.calls; // only the call row matters to these tests
      if (isCall) state.inserts++;
      return {
        values(v: Record<string, unknown>) {
          if (isCall) state.callValues.push(v);
          const returning = async () => (state.duplicateInsert ? [] : [{ id: 'call-db-1', ...v }]);
          return { returning, onConflictDoNothing: () => ({ returning }) };
        },
      };
    },
    // Tripwire: nothing on this route builds a select. A real (un-mocked)
    // `lastDialerForCaller` that reaches the table lands here and fails the test.
    select(...args: unknown[]) {
      state.selects(...args);
      throw new Error('unexpected db.select on the inbound route');
    },
    update(_table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          state.updates.push(values);
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
  state.lastDialerId = null;
  state.findByPhoneResult = null;
  state.findByPhone.mockClear();
  state.stickyAgentForCaller.mockClear();
  state.lastDialerForCaller.mockReset();
  state.lastDialerForCaller.mockImplementation(async () => state.lastDialerId);
  state.selects.mockClear();
  state.inserts = 0;
  state.callValues = [];
  state.duplicateInsert = false;
  state.existingCall = null;
  state.updates = [];
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

/** Twilio posts application/x-www-form-urlencoded. `app.inject` serializes an
 *  object payload as JSON regardless of the content-type header, which the
 *  form parser above would turn into one garbage key — so encode for real. */
function form(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

async function ring(overrides: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/telephony/twilio/inbound',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({
      From: '+13105550002',
      To: '+16195550100',
      CallSid: 'CA_test_1',
      ...overrides,
    }),
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

describe('POST /telephony/twilio/inbound — a callback to a pool DID rings the rep who last power-dialed the caller', () => {
  // 2026-09-22: 25 callbacks to pool numbers in a day, 18 from people we had
  // power-dialed from that very DID, only 7 with a sticky (a sticky is written
  // on a CONNECT only). The other 11 were attributed to "any user in the org"
  // and went to a voicemail box nobody owns. The rep who last dialed them is
  // who they are calling back.
  beforeEach(() => {
    state.owned = OWNED({ kind: 'dialer_pool', assignedUserId: null });
    state.stickyAgentId = null;
    state.repRow = { id: 'rep-3', noAnswerForwardE164: null };
    state.sfConn = null;
  });

  it('no sticky, a last dial attempt by rep-3 → <Dial><Client> rings rep-3 AND the call row is attributed to rep-3', async () => {
    state.lastDialerId = 'rep-3';

    const res = await ring();

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Dial');
    expect(res.body).toContain('<Client>rep_rep3</Client>');
    expect(res.body).not.toContain('<Record');
    // Attribution, not just the ring: the call lands in rep-3's Recent list
    // and syncs through rep-3's Salesforce connection.
    expect(state.callValues).toHaveLength(1);
    expect(state.callValues[0]!.userId).toBe('rep-3');
    // The lookup is keyed on the DID's org, the NORMALIZED caller, and the
    // very DID they rang back (same-DID rows win inside the lookup).
    expect(state.lastDialerForCaller).toHaveBeenCalledTimes(1);
    expect(state.lastDialerForCaller.mock.calls[0]!.slice(1)).toEqual(['org-1', '+13105550002', '+16195550100']);
  });

  it('a raw From that only normalizes to E.164 reaches the lookup normalized', async () => {
    state.lastDialerId = 'rep-3';
    await ring({ From: '(310) 555-0002' });
    expect(state.lastDialerForCaller.mock.calls[0]!.slice(1)).toEqual(['org-1', '+13105550002', '+16195550100']);
  });

  it('sticky present → the sticky rep wins even though a different rep dialed later, and the attempt log is not consulted', async () => {
    state.stickyAgentId = 'rep-2';
    state.lastDialerId = 'rep-3';
    state.repRow = { id: 'rep-2', noAnswerForwardE164: null };

    const res = await ring();

    expect(res.body).toContain('<Client>rep_rep2</Client>');
    expect(res.body).not.toContain('rep_rep3');
    expect(state.callValues[0]!.userId).toBe('rep-2');
    // A connect is the stronger signal; the fallback query is skipped outright.
    expect(state.lastDialerForCaller).not.toHaveBeenCalled();
  });

  it('neither sticky nor a dial attempt → today\'s voicemail path, attributed to the org-fallback user', async () => {
    state.lastDialerId = null;
    state.repRow = { id: 'org-user-jona', noAnswerForwardE164: null };

    const res = await ring();

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<Client');
    expect(res.body).toContain('<Record');
    expect(state.lastDialerForCaller).toHaveBeenCalledTimes(1);
    expect(state.callValues[0]!.userId).toBe('org-user-jona');
  });

  it('an anonymous caller → no attempt lookup hits the table; voicemail as before', async () => {
    // Run the REAL lookup against this route's DB fake: its caller-shape guard
    // must answer null before building a select (the fake's select throws).
    state.lastDialerForCaller.mockImplementation((...args) => state.realLastDialerForCaller!(...args));
    state.repRow = { id: 'org-user-jona', noAnswerForwardE164: null };

    const res = await ring({ From: 'anonymous' });

    expect(res.statusCode).toBe(200);
    expect(state.selects).not.toHaveBeenCalled();
    expect(res.body).not.toContain('<Client');
    expect(res.body).toContain('<Record');
    expect(state.callValues[0]!.userId).toBe('org-user-jona');
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
      payload: form({ CallSid: 'CA_test_1', RecordingUrl: 'https://api.twilio.com/rec/RE1', RecordingDuration: '11' }),
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
      payload: form({ CallSid: 'CA_test_1', DialCallStatus: 'no-answer' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(new RegExp(`<Record[^>]*action="https://api\\.example\\.com/telephony/twilio/inbound/voicemail-done\\?callDbId=${id}"`));
  });
});

describe('POST /telephony/twilio/inbound/dial-result — answeredAt is the "rep picked up" signal', () => {
  // `answered_at` was NULL on every one of a week's 257 production inbound
  // rows: nothing ever wrote it. Both "the rep answered" and "the caller
  // finished voicemail" end with status `completed`, so without this stamp the
  // Recent list cannot tell a 30-second voicemail from a 30-second conversation.
  const id = '33333333-3333-3333-3333-333333333333';

  async function dialResult(params: Record<string, string>) {
    return app.inject({
      method: 'POST',
      url: `/telephony/twilio/inbound/dial-result?callDbId=${id}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ CallSid: 'CA_test_1', ...params }),
    });
  }

  beforeEach(() => {
    state.existingCall = { id, userId: 'rep-1', normalizedToNumber: '+16195550100' };
    state.owned = OWNED({ inboundForwardToE164: null });
    state.repRow = { id: 'rep-1', noAnswerForwardE164: null };
  });

  it('DialCallStatus=completed → the row is patched with status completed AND an answeredAt Date', async () => {
    const res = await dialResult({ DialCallStatus: 'completed', DialCallDuration: '500' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Hangup/>');
    const patch = state.updates.find((u) => u.status === 'completed');
    expect(patch).toBeDefined();
    expect(patch?.answeredAt).toBeInstanceOf(Date);
    expect(patch?.durationSeconds).toBe(500);
  });

  // dial-result fires when the leg ENDS. Stamping "now" would make answered_at
  // equal ended_at on every inbound row — a column that lies about a 500 s
  // conversation. The answer time is the end minus the talk time Twilio reports.
  it('answeredAt is when the rep picked up: the end minus DialCallDuration', async () => {
    const before = Date.now();
    await dialResult({ DialCallStatus: 'completed', DialCallDuration: '500' });
    const patch = state.updates.find((u) => u.status === 'completed');
    const answeredAt = (patch?.answeredAt as Date).getTime();
    expect(answeredAt).toBeLessThanOrEqual(before - 500_000 + 5_000);
    expect(answeredAt).toBeGreaterThanOrEqual(before - 500_000 - 5_000);
  });

  it('DialCallStatus=no-answer → nothing writes answeredAt (the row stays unanswered for the voicemail / missed rendering)', async () => {
    const res = await dialResult({ DialCallStatus: 'no-answer' });
    expect(res.statusCode).toBe(200);
    expect(state.updates.some((u) => 'answeredAt' in u)).toBe(false);
    expect(state.updates.some((u) => u.status === 'completed')).toBe(false);
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
