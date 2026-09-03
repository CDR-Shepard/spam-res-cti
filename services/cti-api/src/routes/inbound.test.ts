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

vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index.js')>();
  return { ...actual, getDb: () => fakeDb() };
});

import { registerInboundRoutes } from './inbound.js';

/** Just enough drizzle for the inbound-ring handler. */
function fakeDb() {
  return {
    query: {
      outboundNumbers: { findFirst: async () => state.owned },
      users: { findFirst: async () => state.repRow },
      salesforceConnections: { findFirst: async () => state.sfConn },
    },
    insert(_table: unknown) {
      return {
        values(v: Record<string, unknown>) {
          return { returning: async () => [{ id: 'call-db-1', ...v }] };
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
  } as unknown as ReturnType<typeof import('../db/index.js').getDb>;
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
