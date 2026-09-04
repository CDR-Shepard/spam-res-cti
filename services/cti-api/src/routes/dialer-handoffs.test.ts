import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mocks — mirrors the fake-DB-injection convention used elsewhere in this
// package (e.g. dialer/engine.test.ts's fakeDb): `where` clauses are NOT
// introspected, each test configures the single fixture it needs and the
// fake returns it unconditionally. `state` is `vi.hoisted` so the
// `vi.mock(...)` factories (which run before the top-level `const`s below)
// can close over it.
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  cfg: { HANDOFF_SHARED_SECRET: undefined as string | undefined },
  authedUser: null as {
    userId: string; orgId: string; email: string; isAdmin: boolean; powerDialerEnabled: boolean;
  } | null,
  db: null as unknown,
}));

vi.mock('../config.js', () => ({
  loadConfig: () => state.cfg,
}));

vi.mock('../auth/session.js', () => ({
  resolveSession: async (_bearer: string | undefined) => state.authedUser,
}));

vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return {
    ...actual,
    getDb: () => state.db,
  };
});

import { registerDialerRoutes } from './dialer.js';
import { claimPendingHandoff, upsertPendingHandoff } from '../dialer/handoff-store.js';

// ---------------------------------------------------------------------------
// Fake DB: just enough of the drizzle surface handoff-store.ts + the two
// routes touch. See handoff-store.ts for the real (production) shapes this
// mirrors.
// ---------------------------------------------------------------------------
interface FakeConn {
  userId: string;
  sfUserId: string;
}
interface FakeUser {
  id: string;
  orgId: string;
  powerDialerEnabled?: boolean;
}
interface HandoffRow {
  id: string;
  orgId: string | null;
  salesforceUserId: string;
  objectType: string;
  recordIds: string[];
  status: string;
  createdAt: Date;
  claimedAt: Date | null;
}

function makeFakeDb(opts: { conn?: FakeConn | null; user?: FakeUser | null } = {}) {
  const handoffs: HandoffRow[] = [];
  const conn = opts.conn ?? null;
  const user = opts.user ?? null;
  // Tracked so `upsertPendingHandoff`'s transaction + advisory-lock usage
  // (handoff-store.ts) can be asserted on directly — see the
  // 'upsertPendingHandoff concurrency' describe block below.
  let transactionCallCount = 0;
  const advisoryLockQueries: Array<{ queryChunks: unknown[] }> = [];

  // Shared by both the top-level `db.delete/.insert` (used by claimPendingHandoff's
  // callers elsewhere) and the transactional `tx.delete/.insert` that
  // `upsertPendingHandoff` now runs through — same in-memory `handoffs`
  // array either way, mirroring dialer/engine.test.ts's fakeDb `transaction`
  // convention of routing tx writes through the same shared state.
  function deleteImpl() {
    return {
      where: async () => {
        for (let i = handoffs.length - 1; i >= 0; i--) {
          if (handoffs[i]!.status === 'pending') handoffs.splice(i, 1);
        }
      },
    };
  }
  function insertImpl() {
    return {
      values: (values: Omit<HandoffRow, 'id' | 'createdAt' | 'claimedAt'>) => ({
        returning: async () => {
          const row: HandoffRow = { id: randomUUID(), createdAt: new Date(), claimedAt: null, ...values };
          handoffs.push(row);
          return [row];
        },
      }),
    };
  }

  return {
    query: {
      salesforceConnections: { findFirst: async () => conn },
      users: { findFirst: async () => user },
    },
    delete(_table: unknown) {
      return deleteImpl();
    },
    insert(_table: unknown) {
      return insertImpl();
    },
    async transaction(fn: (tx: unknown) => Promise<unknown>) {
      transactionCallCount++;
      const tx = {
        execute: async (query: { queryChunks: unknown[] }) => {
          advisoryLockQueries.push(query);
          return { rows: [] };
        },
        delete: (_table: unknown) => deleteImpl(),
        insert: (_table: unknown) => insertImpl(),
      };
      return fn(tx);
    },
    async execute(query: { queryChunks: unknown[] }) {
      // The raw `sql\`...${salesforceUserId}...\`` tag embeds a plain
      // interpolated JS string directly as a queryChunks entry (unlike
      // drizzle's `eq()`, which wraps it in a `Param`) — pull it out to
      // simulate the real `UPDATE ... WHERE ... RETURNING` claim.
      const sfUserId = query.queryChunks.find((c) => typeof c === 'string') as string | undefined;
      if (!sfUserId) return { rows: [] };
      const candidates = handoffs
        .filter((r) => r.salesforceUserId === sfUserId && r.status === 'pending')
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const row = candidates[0];
      if (!row) return { rows: [] };
      row.status = 'claimed';
      row.claimedAt = new Date();
      return { rows: [{ object_type: row.objectType, record_ids: row.recordIds }] };
    },
    _pendingCount(sfUserId: string): number {
      return handoffs.filter((r) => r.salesforceUserId === sfUserId && r.status === 'pending').length;
    },
    _transactionCallCount(): number {
      return transactionCallCount;
    },
    _advisoryLockQueries(): Array<{ queryChunks: unknown[] }> {
      return advisoryLockQueries;
    },
  };
}
type FakeDb = ReturnType<typeof makeFakeDb>;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let app: FastifyInstance;

beforeEach(async () => {
  state.cfg = { HANDOFF_SHARED_SECRET: undefined };
  state.authedUser = null;
  state.db = makeFakeDb();
  app = Fastify();
  await registerDialerRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const SF_USER_ID = '005000000000001AAA';
const RECORD_ID_1 = '00Q000000000001AAA';
const RECORD_ID_2 = '00Q000000000002AAA';
const LOCAL_USER_ID = 'user-uuid-1';

describe('POST /dialer/handoffs', () => {
  it('returns 503 when HANDOFF_SHARED_SECRET is unset (never accepts an unauthed write)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dialer/handoffs',
      payload: { salesforceUserId: SF_USER_ID, objectType: 'Lead', recordIds: [RECORD_ID_1] },
    });
    expect(res.statusCode).toBe(503);
  });

  it('returns 401 when the secret is configured but the provided header is wrong', async () => {
    state.cfg.HANDOFF_SHARED_SECRET = 'a-very-long-shared-secret-value';
    const res = await app.inject({
      method: 'POST',
      url: '/dialer/handoffs',
      headers: { 'x-handoff-secret': 'wrong-secret-value-here' },
      payload: { salesforceUserId: SF_USER_ID, objectType: 'Lead', recordIds: [RECORD_ID_1] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when no secret header is provided at all', async () => {
    state.cfg.HANDOFF_SHARED_SECRET = 'a-very-long-shared-secret-value';
    const res = await app.inject({
      method: 'POST',
      url: '/dialer/handoffs',
      payload: { salesforceUserId: SF_USER_ID, objectType: 'Lead', recordIds: [RECORD_ID_1] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for an invalid body', async () => {
    state.cfg.HANDOFF_SHARED_SECRET = 'a-very-long-shared-secret-value';
    const res = await app.inject({
      method: 'POST',
      url: '/dialer/handoffs',
      headers: { 'x-handoff-secret': 'a-very-long-shared-secret-value' },
      payload: { salesforceUserId: SF_USER_ID, objectType: 'Account', recordIds: [RECORD_ID_1] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a pending handoff and supersedes an earlier pending one for the same rep', async () => {
    state.cfg.HANDOFF_SHARED_SECRET = 'a-very-long-shared-secret-value';
    const first = await app.inject({
      method: 'POST',
      url: '/dialer/handoffs',
      headers: { 'x-handoff-secret': 'a-very-long-shared-secret-value' },
      payload: { salesforceUserId: SF_USER_ID, objectType: 'Lead', recordIds: [RECORD_ID_1] },
    });
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body).handoffId).toBeTruthy();

    // Same rep clicks again before the first is ever claimed — the second
    // POST must supersede (not stack alongside) the first.
    const second = await app.inject({
      method: 'POST',
      url: '/dialer/handoffs',
      headers: { 'x-handoff-secret': 'a-very-long-shared-secret-value' },
      payload: { salesforceUserId: SF_USER_ID, objectType: 'Opportunity', recordIds: [RECORD_ID_2] },
    });
    expect(second.statusCode).toBe(200);

    expect((state.db as FakeDb)._pendingCount(SF_USER_ID)).toBe(1);

    // The rep's poll should see the SECOND selection, proving the first was
    // actually replaced rather than merely outranked by recency.
    state.authedUser = { userId: LOCAL_USER_ID, orgId: 'org-1', email: 'rep@example.com', isAdmin: false, powerDialerEnabled: true };
    (state.db as unknown as { query: { salesforceConnections: { findFirst: () => Promise<FakeConn | null> } } }).query.salesforceConnections.findFirst =
      async () => ({ userId: LOCAL_USER_ID, sfUserId: SF_USER_ID });
    const poll = await app.inject({ method: 'GET', url: '/dialer/handoffs/pending', headers: { authorization: 'Bearer tok' } });
    expect(poll.statusCode).toBe(200);
    expect(JSON.parse(poll.body)).toEqual({ handoff: { objectType: 'Opportunity', recordIds: [RECORD_ID_2] } });
  });
});

describe('GET /dialer/handoffs/pending', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/dialer/handoffs/pending' });
    expect(res.statusCode).toBe(401);
  });

  it('returns { handoff: null } when the rep has no linked Salesforce connection', async () => {
    state.authedUser = { userId: LOCAL_USER_ID, orgId: 'org-1', email: 'rep@example.com', isAdmin: false, powerDialerEnabled: true };
    state.db = makeFakeDb({ conn: null });
    const res = await app.inject({ method: 'GET', url: '/dialer/handoffs/pending', headers: { authorization: 'Bearer tok' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ handoff: null });
  });

  it('claims and returns a pending handoff once, then null on the next poll (one-shot claim)', async () => {
    const db = makeFakeDb({ conn: { userId: LOCAL_USER_ID, sfUserId: SF_USER_ID } });
    state.db = db;
    await upsertPendingHandoff(db as never, {
      orgId: null,
      salesforceUserId: SF_USER_ID,
      objectType: 'Lead',
      recordIds: [RECORD_ID_1, RECORD_ID_2],
    });
    state.authedUser = { userId: LOCAL_USER_ID, orgId: 'org-1', email: 'rep@example.com', isAdmin: false, powerDialerEnabled: true };

    const firstPoll = await app.inject({ method: 'GET', url: '/dialer/handoffs/pending', headers: { authorization: 'Bearer tok' } });
    expect(firstPoll.statusCode).toBe(200);
    expect(JSON.parse(firstPoll.body)).toEqual({ handoff: { objectType: 'Lead', recordIds: [RECORD_ID_1, RECORD_ID_2] } });

    const secondPoll = await app.inject({ method: 'GET', url: '/dialer/handoffs/pending', headers: { authorization: 'Bearer tok' } });
    expect(secondPoll.statusCode).toBe(200);
    expect(JSON.parse(secondPoll.body)).toEqual({ handoff: null });
  });
});

describe('claimPendingHandoff concurrency', () => {
  it('two concurrent claims against the same pending row resolve with exactly one non-null', async () => {
    const db = makeFakeDb();
    await upsertPendingHandoff(db as never, {
      orgId: null,
      salesforceUserId: SF_USER_ID,
      objectType: 'Lead',
      recordIds: [RECORD_ID_1],
    });

    const [a, b] = await Promise.all([
      claimPendingHandoff(db as never, SF_USER_ID),
      claimPendingHandoff(db as never, SF_USER_ID),
    ]);

    const nonNull = [a, b].filter((x) => x !== null);
    expect(nonNull).toHaveLength(1);
    expect(nonNull[0]).toEqual({ objectType: 'Lead', recordIds: [RECORD_ID_1] });
  });
});

describe('upsertPendingHandoff concurrency', () => {
  // A true Postgres race (two concurrent POSTs interleaving delete-then-insert
  // into two live 'pending' rows) can't be exercised against this in-memory
  // fake — there's no real interleaving to race. What IS feasible, and what
  // this asserts, is that upsertPendingHandoff actually goes through the
  // serialization mechanism that prevents that race in real Postgres: a
  // transaction holding a per-rep `pg_advisory_xact_lock`, mirroring
  // engine.ts's `advanceSession` claim guard. The hard concurrency guarantee
  // itself — that two overlapping transactions can never both hold the lock,
  // and that even a writer bypassing this code path entirely still can't
  // leave two 'pending' rows for one rep — is enforced by Postgres (the
  // advisory lock, and the `dialer_handoffs_one_pending_per_rep` partial
  // unique index added in migrations/0019_dialer_handoffs.sql) and needs a
  // real database to exercise.
  it('runs the supersede inside a transaction holding a per-rep advisory lock', async () => {
    const db = makeFakeDb();

    await upsertPendingHandoff(db as never, {
      orgId: null,
      salesforceUserId: SF_USER_ID,
      objectType: 'Lead',
      recordIds: [RECORD_ID_1],
    });

    expect(db._transactionCallCount()).toBe(1);

    const lockQueries = db._advisoryLockQueries();
    expect(lockQueries).toHaveLength(1);

    // The raw `sql` tag keeps literal SQL text in `{ value: [...] }` chunks
    // and embeds interpolated JS values (here, the rep's Salesforce user id)
    // directly — see the `execute()` fake above for the same convention.
    const [query] = lockQueries;
    const literalText = query!.queryChunks
      .filter((c): c is { value: unknown[] } => typeof c === 'object' && c !== null && 'value' in c)
      .flatMap((c) => c.value)
      .join('');
    expect(literalText).toContain('pg_advisory_xact_lock');
    expect(query!.queryChunks).toContain(SF_USER_ID);
  });

  it('still supersedes an earlier pending row for the same rep when run through the transaction', async () => {
    const db = makeFakeDb();

    await upsertPendingHandoff(db as never, {
      orgId: null,
      salesforceUserId: SF_USER_ID,
      objectType: 'Lead',
      recordIds: [RECORD_ID_1],
    });
    await upsertPendingHandoff(db as never, {
      orgId: null,
      salesforceUserId: SF_USER_ID,
      objectType: 'Opportunity',
      recordIds: [RECORD_ID_2],
    });

    expect(db._pendingCount(SF_USER_ID)).toBe(1);
    expect(db._transactionCallCount()).toBe(2);
  });
});

describe('power dialer gate (spec 2026-08-25)', () => {
  const disabled = {
    userId: 'u1', orgId: 'o1', email: 'rep@x.com', isAdmin: false, powerDialerEnabled: false,
  };

  it.each([
    ['GET', '/dialer/salesforce/listviews?object=Lead'],
    ['POST', '/dialer/sessions'],
    ['POST', '/dialer/sessions/from-listview'],
    ['GET', '/dialer/handoffs/pending'],
  ] as const)('%s %s → 403 power_dialer_disabled when the flag is off', async (method, url) => {
    state.authedUser = disabled;
    state.db = makeFakeDb();
    const res = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'power_dialer_disabled' });
  });

  it('an enabled user passes the gate (listviews fails LATER, not with 403)', async () => {
    state.authedUser = { ...disabled, powerDialerEnabled: true };
    state.db = makeFakeDb();
    const res = await app.inject({ method: 'GET', url: '/dialer/salesforce/listviews?object=Lead' });
    expect(res.statusCode).not.toBe(403); // gate passed; 502 from unmocked SF is fine
  });

  it('session management is NOT gated: stop with the flag off is not a power_dialer 403', async () => {
    state.authedUser = disabled;
    state.db = makeFakeDb();
    const res = await app.inject({ method: 'POST', url: '/dialer/sessions/some-id/stop' });
    expect(res.json()).not.toEqual({ error: 'power_dialer_disabled' });
  });

  it('the SF handoff relay refuses a resolved target whose flag is off', async () => {
    state.cfg.HANDOFF_SHARED_SECRET = 's3cret';
    state.db = makeFakeDb({
      conn: { userId: 'u1', sfUserId: '005000000000001' },
      user: { id: 'u1', orgId: 'o1', powerDialerEnabled: false },
    });
    const res = await app.inject({
      method: 'POST', url: '/dialer/handoffs',
      headers: { 'x-handoff-secret': 's3cret' },
      payload: { salesforceUserId: '005000000000001', objectType: 'Lead', recordIds: ['00Q000000000001'] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'power_dialer_disabled' });
  });

  it('the relay still accepts an UNRESOLVED target (no SF connection yet) — pickup is gated instead', async () => {
    state.cfg.HANDOFF_SHARED_SECRET = 's3cret';
    state.db = makeFakeDb({ conn: null, user: null });
    const res = await app.inject({
      method: 'POST', url: '/dialer/handoffs',
      headers: { 'x-handoff-secret': 's3cret' },
      payload: { salesforceUserId: '005000000000001', objectType: 'Lead', recordIds: ['00Q000000000001'] },
    });
    expect(res.statusCode).toBe(200);
  });
});
