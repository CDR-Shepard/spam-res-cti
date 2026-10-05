/**
 * The admin number routes and the AI pool (`ai_pool`):
 *  - Import from Twilio files a number whose Twilio FriendlyName contains
 *    "(ai_pool)" as an AI number, and NEVER re-kinds a row that exists.
 *  - Register-Twilio-inbound only touches Twilio, never the row's kind.
 *  - Add / edit accept the AI kind, and an AI number is never a rep's.
 *  - A rep's own number list never shows an AI number.
 * Harness: admin-sms-webhooks.test.ts (hoisted state, mocked @cti/auth / @cti/db
 * / config, Twilio = stubbed global fetch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const CFG = {
  TWILIO_ACCOUNT_SID: 'ACtest0000000000000000000000000000',
  TWILIO_AUTH_TOKEN: 'test-auth-token',
  API_PUBLIC_URL: 'https://ctiapi-production.up.railway.app',
  TELEPHONY_PROVIDER: 'twilio',
};
const NUMBER_ID = '11111111-1111-1111-1111-111111111111';
const REP_ID = '22222222-2222-4222-8222-222222222222';
const AI_SID = 'PNc85dd1b75b6c940a20b7e79199cf904f';

const state = vi.hoisted(() => ({
  user: null as { userId: string; orgId: string; email: string; isAdmin: boolean } | null,
  existing: null as Record<string, unknown> | null,
  inserted: [] as Array<Record<string, unknown>>,
  conflictSets: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  selectWhere: [] as unknown[],
  twilioNumbers: [] as Array<{ phone_number: string; friendly_name: string; sid: string }>,
}));

vi.mock('../config.js', () => ({ loadConfig: () => CFG }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.user,
}));
vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return {
    ...actual,
    getDb: () => ({
      query: {
        outboundNumbers: { findFirst: async () => state.existing ?? undefined },
        users: { findFirst: async () => ({ id: REP_ID }) },
      },
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          state.inserted.push(v);
          return {
            onConflictDoUpdate: (conf: { set: Record<string, unknown> }) => {
              state.conflictSets.push(conf.set);
              const p = Promise.resolve(undefined) as Promise<undefined> & { returning: () => Promise<unknown[]> };
              p.returning = async () => [{ id: NUMBER_ID, ...v }];
              return p;
            },
          };
        },
      }),
      update: () => ({
        set: (v: Record<string, unknown>) => {
          state.updates.push(v);
          return { where: () => ({ returning: async () => [{ id: NUMBER_ID, ...state.existing, ...v }] }) };
        },
      }),
      select: () => ({
        from: () => ({
          where: (w: unknown) => {
            state.selectWhere.push(w);
            return { orderBy: async () => [] };
          },
        }),
      }),
    }),
  };
});

import { registerAdminRoutes } from './admin.js';

const admin = { userId: 'a1', orgId: 'o1', email: 'admin@x.com', isAdmin: true };
const rep = { userId: REP_ID, orgId: 'o1', email: 'rep@x.com', isAdmin: false };
let fetchCalls: string[];
let app: FastifyInstance;

beforeEach(async () => {
  state.user = admin;
  state.existing = null;
  state.inserted = [];
  state.conflictSets = [];
  state.updates = [];
  state.selectWhere = [];
  state.twilioNumbers = [];
  fetchCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetchCalls.push(url);
      if (url.includes('IncomingPhoneNumbers.json')) {
        return new Response(JSON.stringify({ incoming_phone_numbers: state.twilioNumbers, next_page_uri: null }), { status: 200 });
      }
      return new Response(JSON.stringify({ sid: AI_SID, friendly_name: 'AI calls (ai_pool)' }), { status: 200 });
    }),
  );
  app = Fastify();
  await registerAdminRoutes(app);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
});

describe('POST /admin/outbound-numbers/import-twilio — the "(ai_pool)" Twilio name', () => {
  it('a NEW number named "AI calls (ai_pool)" imports as ai_pool; any other as agent', async () => {
    state.twilioNumbers = [
      { phone_number: '+16197244374', friendly_name: 'AI calls (ai_pool)', sid: AI_SID },
      { phone_number: '+16195550100', friendly_name: '(619) 555-0100', sid: `PN${'0'.repeat(32)}` },
      { phone_number: '+16195550101', friendly_name: 'spare (AI_POOL)', sid: `PN${'1'.repeat(32)}` },
    ];
    const res = await app.inject({ method: 'POST', url: '/admin/outbound-numbers/import-twilio' });
    expect(res.statusCode).toBe(200);
    expect(state.inserted.map((v) => [v.e164, v.kind])).toEqual([
      ['+16197244374', 'ai_pool'],
      ['+16195550100', 'agent'],
      ['+16195550101', 'ai_pool'],
    ]);
    // An AI number lands unassigned (never in a rep's pool).
    expect(state.inserted[0]!.assignedUserId ?? null).toBeNull();
  });

  it('never re-kinds an existing row: the ON CONFLICT update does not touch kind', async () => {
    state.twilioNumbers = [{ phone_number: '+16197244374', friendly_name: 'AI calls (ai_pool)', sid: AI_SID }];
    await app.inject({ method: 'POST', url: '/admin/outbound-numbers/import-twilio' });
    expect(state.conflictSets).toHaveLength(1);
    expect(state.conflictSets[0]).toEqual({ twilioSid: AI_SID, provider: 'twilio', inboundEnabled: true });
    expect(state.conflictSets[0]).not.toHaveProperty('kind');
    expect(state.conflictSets[0]).not.toHaveProperty('assignedUserId');
  });
});

describe('POST /admin/outbound-numbers/:id/register-twilio-inbound — never re-kinds', () => {
  it('only re-points the Twilio webhooks, even for a number Twilio names "(ai_pool)"', async () => {
    state.existing = { id: NUMBER_ID, orgId: 'o1', kind: 'agent', assignedUserId: null };
    const res = await app.inject({
      method: 'POST',
      url: `/admin/outbound-numbers/${NUMBER_ID}/register-twilio-inbound`,
      payload: { twilioSid: AI_SID },
    });
    expect(res.statusCode).toBe(200);
    expect(state.inserted).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });
});

describe('POST /admin/outbound-numbers — add as an AI number', () => {
  it('a new number with kind ai_pool is stored as ai_pool, unassigned', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/outbound-numbers', payload: { e164: '+16197244374', kind: 'ai_pool' } });
    expect(res.statusCode).toBe(200);
    expect(state.inserted[0]).toMatchObject({ e164: '+16197244374', kind: 'ai_pool', assignedUserId: null });
    expect(state.conflictSets[0]).not.toHaveProperty('kind');
  });

  it('without a kind it stays the default agent', async () => {
    await app.inject({ method: 'POST', url: '/admin/outbound-numbers', payload: { e164: '+16195550100' } });
    expect(state.inserted[0]!.kind).toBe('agent');
  });

  it('refuses ai_pool together with a rep', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/outbound-numbers', payload: { e164: '+16197244374', kind: 'ai_pool', assignedUserId: REP_ID },
    });
    expect(res.statusCode).toBe(400);
    expect(state.inserted).toHaveLength(0);
  });

  it('refuses to assign a rep to an existing AI number by re-adding it', async () => {
    state.existing = { id: NUMBER_ID, orgId: 'o1', e164: '+16197244374', kind: 'ai_pool', assignedUserId: null };
    const res = await app.inject({ method: 'POST', url: '/admin/outbound-numbers', payload: { e164: '+16197244374', assignedUserId: REP_ID } });
    expect(res.statusCode).toBe(400);
    expect(state.inserted).toHaveLength(0);
  });

  it('refuses to re-kind an existing number through Add (409: change it on its row)', async () => {
    state.existing = { id: NUMBER_ID, orgId: 'o1', e164: '+16197244374', kind: 'agent', assignedUserId: null };
    const res = await app.inject({ method: 'POST', url: '/admin/outbound-numbers', payload: { e164: '+16197244374', kind: 'ai_pool' } });
    expect(res.statusCode).toBe(409);
    expect(state.inserted).toHaveLength(0);
  });
});

describe('PATCH /admin/outbound-numbers/:id — the AI calls kind', () => {
  it('moving a number into AI calls un-assigns it', async () => {
    state.existing = { id: NUMBER_ID, orgId: 'o1', kind: 'agent', assignedUserId: REP_ID };
    const res = await app.inject({ method: 'PATCH', url: `/admin/outbound-numbers/${NUMBER_ID}`, payload: { kind: 'ai_pool' } });
    expect(res.statusCode).toBe(200);
    expect(state.updates[0]).toMatchObject({ kind: 'ai_pool', assignedUserId: null });
  });

  it('refuses to assign a rep to an AI number', async () => {
    state.existing = { id: NUMBER_ID, orgId: 'o1', kind: 'ai_pool', assignedUserId: null };
    const res = await app.inject({ method: 'PATCH', url: `/admin/outbound-numbers/${NUMBER_ID}`, payload: { assignedUserId: REP_ID } });
    expect(res.statusCode).toBe(400);
    expect(state.updates).toHaveLength(0);
  });

  it('moving it out of AI calls to a rep in one edit is allowed', async () => {
    state.existing = { id: NUMBER_ID, orgId: 'o1', kind: 'ai_pool', assignedUserId: null };
    const res = await app.inject({
      method: 'PATCH', url: `/admin/outbound-numbers/${NUMBER_ID}`, payload: { kind: 'agent', assignedUserId: REP_ID },
    });
    expect(res.statusCode).toBe(200);
    expect(state.updates[0]).toMatchObject({ kind: 'agent', assignedUserId: REP_ID });
  });
});

describe('GET /admin/outbound-numbers — a rep never sees an AI number', () => {
  it("a rep's list is their own rep-kind numbers", async () => {
    state.user = rep;
    await app.inject({ method: 'GET', url: '/admin/outbound-numbers' });
    const { sql, params } = new PgDialect().sqlToQuery(state.selectWhere[0] as SQL);
    expect(sql).toContain('"outbound_numbers"."kind" in (');
    expect(params).toEqual(['o1', REP_ID, 'agent', 'dialer_pool']);
  });

  it("an admin's list is the whole org (AI numbers included, to manage them)", async () => {
    await app.inject({ method: 'GET', url: '/admin/outbound-numbers' });
    const { params } = new PgDialect().sqlToQuery(state.selectWhere[0] as SQL);
    expect(params).toEqual(['o1']);
  });
});
