/**
 * Route tests for Reset CTI (routes/cti-reset.ts), in the admin-team.test.ts
 * idiom: hoisted `state`, `vi.mock` of @cti/auth and @cti/db, Fastify inject.
 * Pinned here:
 *   - every gate (401, 403 'Admin only', 404);
 *   - targets are same-org, human-only users;
 *   - "reset everyone" leaves out the admin who asks;
 *   - every rendered WHERE and its bound values;
 *   - both stamps use the database's now(), never app time;
 *   - the revoke is single-session, never every session, because the iPhone
 *     app shares the sessions table;
 *   - the audit lines;
 *   - the poll's own rate-limit bucket;
 *   - R2 (controller ruling): reset-signal self-heals a session that already
 *     reset but whose reset-complete POST never landed.
 */
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  detail: null as null | {
    user: { userId: string; orgId: string; email: string; isAdmin: boolean; powerDialerEnabled: boolean; kind: 'human'; isSuperAdmin: boolean };
    sessionCreatedAt: Date;
    ctiResetRequestedAt: Date | null;
  },
  authedUser: null as null | { userId: string; orgId: string; email: string; isAdmin: boolean; powerDialerEnabled: boolean },
  updates: [] as Array<{ table: unknown; set: Record<string, unknown>; where: unknown }>,
  updateRows: [] as Array<Record<string, unknown>>,
  revoked: [] as string[],
  revokedAll: [] as string[],
}));

vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async (_bearer: string | undefined) => state.authedUser,
  resolveSessionDetail: async (_bearer: string | undefined) => state.detail,
  revokeSession: async (bearer: string) => { state.revoked.push(bearer); },
  revokeAllSessionsForUser: async (userId: string) => { state.revokedAll.push(userId); },
}));

vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return { ...actual, getDb: () => fakeDb() };
});

import { schema } from '@cti/db';
import { registerCtiResetRoutes, resetSignalRateKey, RESET_SIGNAL_RATE_MAX } from './cti-reset.js';

/** Copied verbatim from admin-team.test.ts: a drizzle predicate as SQL-ish text. */
function renderPredicate(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(renderPredicate).join('');
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.queryChunks)) return n.queryChunks.map(renderPredicate).join('');
  if (Array.isArray(n.value)) return (n.value as unknown[]).map(renderPredicate).join('');
  if (typeof n.name === 'string' && n.table) return n.name;
  if ('value' in n) return `<param>`;
  return '<?>';
}

/** The values bound to a predicate's params, in order — same walk as renderPredicate. */
function paramsOf(node: unknown): unknown[] {
  if (node === null || node === undefined || typeof node === 'string') return [];
  if (Array.isArray(node)) return node.flatMap(paramsOf);
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.queryChunks)) return n.queryChunks.flatMap(paramsOf);
  if (Array.isArray(n.value)) return []; // a literal SQL string chunk
  if (typeof n.name === 'string' && n.table) return []; // a column
  if ('value' in n) return [n.value];
  return [];
}

/** `update(t).set(v).where(w)` is awaitable (reset-complete) and has `.returning()` (admin routes). */
function fakeDb() {
  return {
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where(where: unknown) {
              state.updates.push({ table, set: values, where });
              return Object.assign(Promise.resolve(undefined), {
                returning: async (_cols?: unknown) => state.updateRows,
              });
            },
          };
        },
      };
    },
  };
}

let app: FastifyInstance;
let logLines: string[];
const logged = (msg: string): Array<Record<string, unknown>> =>
  logLines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === msg);

const ADMIN = { userId: 'a1', orgId: 'o1', email: 'admin@x.com', isAdmin: true, powerDialerEnabled: false };
const REP = { userId: 'u1', orgId: 'o1', email: 'rep@x.com', isAdmin: false, powerDialerEnabled: true, kind: 'human' as const, isSuperAdmin: false };
const TARGET_ID = '22222222-2222-2222-2222-222222222222';
const ISSUED = new Date('2026-09-28T20:00:00.000Z');
const dueDetail = () => ({ user: REP, sessionCreatedAt: ISSUED, ctiResetRequestedAt: new Date('2026-09-28T21:41:00.000Z') });
const staleRequest = () => ({ user: REP, sessionCreatedAt: ISSUED, ctiResetRequestedAt: new Date('2026-09-28T19:00:00.000Z') });

beforeEach(async () => {
  state.detail = null;
  state.authedUser = null;
  state.updates = [];
  state.updateRows = [];
  state.revoked = [];
  state.revokedAll = [];
  logLines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk));
      cb();
    },
  });
  app = Fastify({ logger: { level: 'info', stream } });
  await registerCtiResetRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const signal = () => app.inject({ method: 'GET', url: '/auth/reset-signal', headers: { authorization: 'Bearer tok-1' } });
const complete = () => app.inject({ method: 'POST', url: '/auth/reset-complete', headers: { authorization: 'Bearer tok-1' } });

describe('GET /auth/reset-signal', () => {
  it('401 without a session — and a 401 is all it is: nothing written, nothing revoked', async () => {
    const res = await signal();
    expect(res.statusCode).toBe(401);
    expect(state.updates).toEqual([]);
    expect(state.revoked).toEqual([]);
  });

  it('due when the reset was asked for after this session was issued; never cached', async () => {
    state.detail = dueDetail();
    const res = await signal();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resetDue: true });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('not due when the rep signed in again after the request, or when nobody ever asked', async () => {
    state.detail = staleRequest();
    expect((await signal()).json()).toEqual({ resetDue: false });
    state.detail = { ...staleRequest(), ctiResetRequestedAt: null };
    expect((await signal()).json()).toEqual({ resetDue: false });
  });

  it('is a read: it never writes or revokes, even when due', async () => {
    state.detail = dueDetail();
    await signal();
    expect(state.updates).toEqual([]);
    expect(state.revoked).toEqual([]);
  });
});

describe('POST /auth/reset-complete', () => {
  it('401 without a session: nothing stamped, nothing revoked', async () => {
    expect((await complete()).statusCode).toBe(401);
    expect(state.updates).toEqual([]);
    expect(state.revoked).toEqual([]);
  });

  it('409 when this session is not due: nothing stamped, nothing revoked', async () => {
    state.detail = staleRequest();
    const res = await complete();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'No reset pending' });
    expect(state.updates).toEqual([]);
    expect(state.revoked).toEqual([]);
  });

  it('due: stamps completed_at with the database now(), then revokes ONLY the calling session', async () => {
    state.detail = dueDetail();
    const res = await complete();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(state.updates).toHaveLength(1);
    const u = state.updates[0]!;
    expect(u.table).toBe(schema.users);
    expect(Object.keys(u.set)).toEqual(['ctiResetCompletedAt']);
    expect(renderPredicate(u.set.ctiResetCompletedAt)).toBe('now()');
    expect(renderPredicate(u.where)).toBe('id = <param>');
    expect(paramsOf(u.where)).toEqual(['u1']);
    expect(state.revoked).toEqual(['Bearer tok-1']);
    expect(state.revokedAll).toEqual([]);
    expect(logged('cti_reset_completed')).toEqual([expect.objectContaining({ userId: 'u1' })]);
  });
});

describe('POST /admin/team/:userId/reset-cti', () => {
  const resetOne = (id = TARGET_ID) => app.inject({ method: 'POST', url: `/admin/team/${id}/reset-cti` });

  it('401 without a session; 403 "Admin only" for a rep — nothing written either way', async () => {
    expect((await resetOne()).statusCode).toBe(401);
    state.authedUser = { ...ADMIN, isAdmin: false };
    const res = await resetOne();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Admin only' });
    expect(state.updates).toEqual([]);
  });

  it('404 for an id that is not a uuid', async () => {
    state.authedUser = ADMIN;
    expect((await resetOne('not-a-uuid')).statusCode).toBe(404);
    expect(state.updates).toEqual([]);
  });

  it("404 when the target is not a human user in the admin's org (the UPDATE matched nothing)", async () => {
    state.authedUser = ADMIN;
    state.updateRows = [];
    const res = await resetOne();
    expect(res.statusCode).toBe(404);
    expect(logged('cti_reset_requested')).toEqual([]);
  });

  it('stamps the request with now() and the admin, scoped by id AND org AND kind=human, and audits it', async () => {
    state.authedUser = ADMIN;
    state.updateRows = [{ id: TARGET_ID, ctiResetRequestedAt: new Date('2026-09-28T21:41:00.000Z'), ctiResetCompletedAt: null }];
    const res = await resetOne();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { id: TARGET_ID, ctiResetRequestedAt: '2026-09-28T21:41:00.000Z', ctiResetCompletedAt: null } });
    const u = state.updates[0]!;
    expect(u.table).toBe(schema.users);
    expect(Object.keys(u.set).sort()).toEqual(['ctiResetRequestedAt', 'ctiResetRequestedBy']);
    expect(renderPredicate(u.set.ctiResetRequestedAt)).toBe('now()');
    expect(u.set.ctiResetRequestedBy).toBe('a1');
    expect(renderPredicate(u.where)).toBe('(id = <param> and org_id = <param> and kind = <param>)');
    expect(paramsOf(u.where)).toEqual([TARGET_ID, 'o1', 'human']);
    expect(logged('cti_reset_requested')).toEqual([expect.objectContaining({ adminId: 'a1', targetUserId: TARGET_ID })]);
  });
});

describe('POST /admin/team/reset-cti — everyone but the admin asking', () => {
  const resetAll = () => app.inject({ method: 'POST', url: '/admin/team/reset-cti' });

  it('401 without a session; 403 "Admin only" for a rep — nothing written either way', async () => {
    expect((await resetAll()).statusCode).toBe(401);
    state.authedUser = { ...ADMIN, isAdmin: false };
    expect((await resetAll()).statusCode).toBe(403);
    expect(state.updates).toEqual([]);
  });

  it('every human user in the org EXCEPT the requester, stamped with now() and the admin, one audit line per person', async () => {
    state.authedUser = ADMIN;
    state.updateRows = [{ id: 'u1' }, { id: 'u2' }];
    const res = await resetAll();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ count: 2 });
    const u = state.updates[0]!;
    expect(u.table).toBe(schema.users);
    expect(renderPredicate(u.set.ctiResetRequestedAt)).toBe('now()');
    expect(u.set.ctiResetRequestedBy).toBe('a1');
    expect(renderPredicate(u.where)).toBe('((org_id = <param> and kind = <param>) and id <> <param>)');
    expect(paramsOf(u.where)).toEqual(['o1', 'human', 'a1']);
    expect(logged('cti_reset_requested').map((l) => [l.adminId, l.targetUserId])).toEqual([['a1', 'u1'], ['a1', 'u2']]);
  });

  it('nobody else in the org: count 0 and no audit lines', async () => {
    state.authedUser = ADMIN;
    state.updateRows = [];
    expect((await resetAll()).json()).toEqual({ count: 0 });
    expect(logged('cti_reset_requested')).toEqual([]);
  });
});

describe('the poll has its own rate-limit bucket', () => {
  it('keys on a hash of the session token (never the token itself), else on the IP', () => {
    const key = resetSignalRateKey({ headers: { authorization: 'Bearer secret-token' }, ip: '203.0.113.9' });
    expect(key).toMatch(/^reset-signal:[0-9a-f]{64}$/);
    expect(key).not.toContain('secret-token');
    expect(resetSignalRateKey({ headers: {}, ip: '203.0.113.9' })).toBe('reset-signal-ip:203.0.113.9');
  });

  it("is not counted in the global per-IP limit, and caps each token at RESET_SIGNAL_RATE_MAX a minute", async () => {
    const limited = Fastify();
    await limited.register(rateLimit, { global: true, max: 1, timeWindow: '1 minute' });
    limited.get('/other', async () => ({ ok: true }));
    await registerCtiResetRoutes(limited);
    await limited.ready();
    state.detail = staleRequest();
    const poll = (token: string) => limited.inject({ method: 'GET', url: '/auth/reset-signal', headers: { authorization: `Bearer ${token}` } });

    expect((await limited.inject({ method: 'GET', url: '/other' })).statusCode).toBe(200);
    expect((await limited.inject({ method: 'GET', url: '/other' })).statusCode).toBe(429); // the IP's global budget is spent…
    for (let i = 0; i < RESET_SIGNAL_RATE_MAX; i++) expect((await poll('tok-1')).statusCode).toBe(200); // …the poll isn't in it
    expect((await poll('tok-1')).statusCode).toBe(429); // its own cap, per token
    expect((await poll('tok-2')).statusCode).toBe(200); // another rep behind the same IP is unaffected
    await limited.close();
  });
});

/**
 * Controller ruling R2 (adds to the brief): GET /auth/reset-signal also
 * self-heals a session whose reset-complete POST never landed. A rep who
 * actually reset proves it by holding a session CREATED AFTER the request
 * (isCtiResetDue is false for it) — that alone can only happen because they
 * signed in again post-reset. If cti_reset_completed_at never caught up
 * (the POST failed, dropped, whatever), the Team panel would show "pending"
 * forever, so the poll stamps it itself with a single guarded UPDATE:
 *   - guarded so a session that is DUE never stamps (that would hide a
 *     reset that hasn't happened yet);
 *   - guarded in SQL so it is a true no-op once completed_at already covers
 *     the request (the ordinary case after a clean reset-complete);
 *   - never even attempted when nothing was ever requested — the ordinary
 *     poll for the overwhelming majority of sessions.
 */
describe('GET /auth/reset-signal — self-heals a session that already reset (R2)', () => {
  it('(a) outstanding + fresh session: stamps completed_at with a single guarded UPDATE, pinned', async () => {
    state.detail = staleRequest();
    const res = await signal();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resetDue: false });
    expect(state.updates).toHaveLength(1);
    const u = state.updates[0]!;
    expect(u.table).toBe(schema.users);
    expect(Object.keys(u.set)).toEqual(['ctiResetCompletedAt']);
    expect(renderPredicate(u.set.ctiResetCompletedAt)).toBe('now()');
    const { sql, params } = new PgDialect().sqlToQuery(u.where as SQL);
    expect(sql).toBe(
      '("users"."id" = $1 and "users"."cti_reset_requested_at" > coalesce("users"."cti_reset_completed_at", \'epoch\'))',
    );
    expect(params).toEqual(['u1']);
  });

  it('(b) outstanding + due session: the session is due, so nothing is stamped', async () => {
    state.detail = dueDetail();
    const res = await signal();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resetDue: true });
    expect(state.updates).toEqual([]);
  });

  it('(c) nothing outstanding — nobody ever asked: no UPDATE is even issued', async () => {
    state.detail = { ...staleRequest(), ctiResetRequestedAt: null };
    const res = await signal();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ resetDue: false });
    expect(state.updates).toEqual([]);
  });
});
