/**
 * POST /calls never dials a rep's call from the AI voice agent's own numbers
 * (`ai_pool`), even when a firewall audit pinned one: the DID re-read and the
 * atomic warmup claim are both rep-kind only. Harness as calls.test.ts
 * (hoisted state, vi.mock of config / @cti/auth / @cti/db); the WHEREs are
 * rendered with PgDialect so the filter itself is pinned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const AI_NUMBER = '+16197244374';
const TO = '+16195559999';
const AUDIT_ID = '11111111-2222-4333-8444-555555555555';

const state = vi.hoisted(() => ({
  did: null as Record<string, unknown> | null,
  readWhere: [] as unknown[],
  updateWhere: [] as unknown[],
}));

vi.mock('../config.js', () => ({ loadConfig: () => ({ TELEPHONY_PROVIDER: 'twilio' }) }));
vi.mock('@cti/auth', () => ({
  resolveSession: async () => ({ userId: 'U1', orgId: 'O1', email: 'rep@x.com', isAdmin: false }),
}));
vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return {
    ...actual,
    getDb: () => ({
      query: {
        calls: { findFirst: async () => undefined },
        preCallAudits: {
          findFirst: async () => ({
            id: AUDIT_ID, orgId: 'O1', userId: 'U1', decision: 'ALLOW', toNumberE164: TO,
            fromNumberE164: AI_NUMBER, createdAt: new Date(), campaignKey: null,
          }),
        },
        outboundNumbers: {
          findFirst: async (opts: { where: unknown }) => {
            state.readWhere.push(opts.where);
            return state.did ?? undefined;
          },
        },
      },
      update: () => ({
        set: () => ({
          where: (w: unknown) => {
            state.updateWhere.push(w);
            return { returning: async () => [] }; // at cap: the route answers 429 and stops
          },
        }),
      }),
    }),
  };
});

import { registerCallRoutes } from './calls.js';

const dialect = new PgDialect();
const render = (w: unknown) => dialect.sqlToQuery(w as SQL);
const did = (kind: string) => ({
  id: 'N1', orgId: 'O1', e164: AI_NUMBER, kind, assignedUserId: 'U1', active: true, health: 'healthy',
  firstUsedAt: null, warmupOverrideCap: 100,
});

let app: FastifyInstance;
beforeEach(async () => {
  state.did = null;
  state.readWhere = [];
  state.updateWhere = [];
  app = Fastify();
  await registerCallRoutes(app);
  await app.ready();
});

const dial = () =>
  app.inject({ method: 'POST', url: '/calls', payload: { toNumber: TO, auditId: AUDIT_ID } });

describe('POST /calls — never from an ai_pool number', () => {
  it('re-reads the approved DID with a rep-kind filter', async () => {
    state.did = null; // Postgres: the kind filter matches nothing for an ai_pool number
    const res = await dial();
    expect(res.statusCode).toBe(409);
    const { sql, params } = render(state.readWhere[0]);
    expect(sql).toContain('"outbound_numbers"."kind" in (');
    expect(params).toEqual(expect.arrayContaining(['agent', 'dialer_pool']));
    expect(params).not.toContain('ai_pool');
    expect(state.updateWhere).toHaveLength(0);
  });

  it('refuses (409) and claims nothing even if an ai_pool row came back', async () => {
    state.did = did('ai_pool');
    const res = await dial();
    expect(res.statusCode).toBe(409);
    expect(state.updateWhere).toHaveLength(0);
  });

  it("a rep's own agent number reaches the atomic claim, whose WHERE is rep-kind too", async () => {
    state.did = did('agent');
    const res = await dial();
    expect(res.statusCode).toBe(429);
    const { sql, params } = render(state.updateWhere[0]);
    expect(sql).toContain('"outbound_numbers"."kind" in (');
    expect(params).toEqual(expect.arrayContaining(['agent', 'dialer_pool']));
  });
});
