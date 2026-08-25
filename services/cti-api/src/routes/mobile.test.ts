/**
 * Route-level (Fastify + fake-DB injection) tests for the iPhone caller-ID
 * app's pairing flow, device auth, and caller-directory feed — following the
 * dialer-handoffs.test.ts / calls-disposition.test.ts convention: `where`
 * clauses are NOT introspected (each test configures the single fixture it
 * needs and the fake returns it unconditionally), except where the route
 * under test genuinely branches on a returned value (e.g. mobilePairCodes'
 * usedAt/expiresAt), where the fixture itself encodes the scenario.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  authedUser: null as { userId: string; orgId: string; email: string; isAdmin: boolean } | null,
  pairCode: undefined as { userId: string; usedAt: Date | null; expiresAt: Date } | undefined,
  device: undefined as { id: string; userId: string; revokedAt: Date | null } | undefined,
  devicesList: [] as Array<{ id: string; label: string; createdAt: Date; lastSeenAt: Date }>,
  user: undefined as { id: string; orgId: string; displayName: string | null } | undefined,
  latestVersion: undefined as { version: number; entryCount: number } | undefined,
  entries: [] as Array<{ e164: string; label: string }>,
  deletedPairCodes: false,
  lastUpdateValues: null as Record<string, unknown> | null,
  updateCallCount: 0,
  // How many successive `mobilePairCodes` inserts should simulate a
  // codeHash primary-key collision (`.onConflictDoNothing().returning()`
  // resolving to `[]`) before an insert is allowed to "succeed".
  pairCodeInsertConflictsRemaining: 0,
  pairCodeInsertAttempts: 0,
}));

vi.mock('../auth/session.js', () => ({
  resolveSession: async (_bearer: string | undefined) => state.authedUser,
}));

vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index.js')>();
  return { ...actual, getDb: () => fakeDb() };
});

import {
  registerMobileRoutes,
  allowClaimAttempt,
  globalBudgetAvailable,
  recordClaimFailureGlobal,
  CLAIM_RATE_LIMIT_GLOBAL,
  claimAttemptsByIp,
  claimAttemptsGlobal,
  pairCodeClaimable,
  sortEntriesByDigits,
  paginate,
  generatePairCode,
} from './mobile.js';

/**
 * Just enough of the drizzle surface mobile.ts touches. `update(...).set().where()`
 * is fire-and-forget in every route here (no `.returning()` is ever chained),
 * so it just records what was written. `insert(...).values(...)` returns a
 * thenable (so a plain `await db.insert(...).values(...)` — the
 * `mobileDevices` insert — still works unchanged) that ALSO exposes
 * `.onConflictDoNothing().returning()` — the `mobilePairCodes` insert's
 * retry-on-collision path — resolving to `[]` for
 * `pairCodeInsertConflictsRemaining` calls (simulating a codeHash collision)
 * before "succeeding" with an inserted row.
 */
function fakeDb() {
  return {
    query: {
      mobilePairCodes: { findFirst: async () => state.pairCode },
      mobileDevices: {
        findFirst: async () => state.device,
        findMany: async () => state.devicesList,
      },
      users: { findFirst: async () => state.user },
      callerDirectoryVersions: { findFirst: async () => state.latestVersion },
      callerDirectoryEntries: { findMany: async () => state.entries },
    },
    delete(_table: unknown) {
      return { where: async () => { state.deletedPairCodes = true; } };
    },
    insert(_table: unknown) {
      return {
        values: (values: Record<string, unknown>) => {
          const thenable = Promise.resolve(undefined) as Promise<void> & {
            onConflictDoNothing: () => { returning: () => Promise<Array<Record<string, unknown>>> };
          };
          thenable.onConflictDoNothing = () => ({
            returning: async () => {
              state.pairCodeInsertAttempts++;
              if (state.pairCodeInsertConflictsRemaining > 0) {
                state.pairCodeInsertConflictsRemaining--;
                return [];
              }
              return [{ ...values }];
            },
          });
          return thenable;
        },
      };
    },
    update(_table: unknown) {
      return {
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            state.updateCallCount++;
            state.lastUpdateValues = values;
          },
        }),
      };
    },
  } as unknown as ReturnType<typeof import('../db/index.js').getDb>;
}

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

let app: FastifyInstance;

beforeEach(async () => {
  state.authedUser = null;
  state.pairCode = undefined;
  state.device = undefined;
  state.devicesList = [];
  state.user = undefined;
  state.latestVersion = undefined;
  state.entries = [];
  state.deletedPairCodes = false;
  state.lastUpdateValues = null;
  state.updateCallCount = 0;
  state.pairCodeInsertConflictsRemaining = 0;
  state.pairCodeInsertAttempts = 0;
  claimAttemptsByIp.clear();
  claimAttemptsGlobal.splice(0, claimAttemptsGlobal.length);
  app = Fastify();
  await registerMobileRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------
// POST /mobile/pair/start
// ---------------------------------------------------------------------------
describe('POST /mobile/pair/start', () => {
  it('requires a session', async () => {
    const res = await app.inject({ method: 'POST', url: '/mobile/pair/start' });
    expect(res.statusCode).toBe(401);
  });

  it('mints a 6-digit code with a ~5-minute expiry and deletes prior unused codes first', async () => {
    state.authedUser = { userId: USER_ID, orgId: ORG_ID, email: 'rep@example.com', isAdmin: false };
    const before = Date.now();
    const res = await app.inject({ method: 'POST', url: '/mobile/pair/start', headers: { authorization: 'Bearer tok' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toMatch(/^\d{6}$/);
    const expiresAt = Date.parse(body.expiresAt);
    // 5 minutes, give or take test-runtime slack.
    expect(expiresAt - before).toBeGreaterThan(4 * 60 * 1000);
    expect(expiresAt - before).toBeLessThan(6 * 60 * 1000);
    expect(state.deletedPairCodes).toBe(true);
  });

  it('retries generation on a codeHash collision and still succeeds', async () => {
    state.authedUser = { userId: USER_ID, orgId: ORG_ID, email: 'rep@example.com', isAdmin: false };
    // Simulate two PRIMARY KEY collisions (another still-live code hashing
    // the same digits) before the third randomly generated code is free.
    state.pairCodeInsertConflictsRemaining = 2;
    const res = await app.inject({ method: 'POST', url: '/mobile/pair/start', headers: { authorization: 'Bearer tok' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toMatch(/^\d{6}$/);
    expect(state.pairCodeInsertAttempts).toBe(3);
  });

  it('gives up with a 503 (not an unhandled 500) after exhausting retries', async () => {
    state.authedUser = { userId: USER_ID, orgId: ORG_ID, email: 'rep@example.com', isAdmin: false };
    // Every attempt collides — a pathological run the loop must bound.
    state.pairCodeInsertConflictsRemaining = Number.POSITIVE_INFINITY;
    const res = await app.inject({ method: 'POST', url: '/mobile/pair/start', headers: { authorization: 'Bearer tok' } });
    expect(res.statusCode).toBe(503);
    expect(state.pairCodeInsertAttempts).toBe(5); // MAX_CODE_GENERATION_ATTEMPTS
  });
});

// ---------------------------------------------------------------------------
// POST /mobile/pair/claim
// ---------------------------------------------------------------------------
describe('POST /mobile/pair/claim', () => {
  function claim(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/mobile/pair/claim', payload });
  }

  it('400s an invalid body', async () => {
    const res = await claim({ code: 'abc', deviceLabel: '' });
    expect(res.statusCode).toBe(400);
  });

  it('401s a code that does not exist', async () => {
    state.pairCode = undefined;
    const res = await claim({ code: '123456', deviceLabel: "Jane's iPhone" });
    expect(res.statusCode).toBe(401);
  });

  it('401s an expired code', async () => {
    state.pairCode = { userId: USER_ID, usedAt: null, expiresAt: new Date(Date.now() - 1000) };
    const res = await claim({ code: '123456', deviceLabel: "Jane's iPhone" });
    expect(res.statusCode).toBe(401);
  });

  it('401s an already-used code', async () => {
    state.pairCode = { userId: USER_ID, usedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) };
    const res = await claim({ code: '123456', deviceLabel: "Jane's iPhone" });
    expect(res.statusCode).toBe(401);
  });

  it('mints a device token and returns the rep\'s display name on the happy path', async () => {
    state.pairCode = { userId: USER_ID, usedAt: null, expiresAt: new Date(Date.now() + 60_000) };
    state.user = { id: USER_ID, orgId: ORG_ID, displayName: 'Jane Rep' };
    const res = await claim({ code: '123456', deviceLabel: "Jane's iPhone" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.deviceToken).toBe('string');
    expect(body.deviceToken.length).toBeGreaterThan(20);
    expect(body.user).toEqual({ displayName: 'Jane Rep' });
    // The code was marked used (single-use).
    expect(state.updateCallCount).toBeGreaterThan(0);
    expect(state.lastUpdateValues).toHaveProperty('usedAt');
  });

  it('rate-limits claim attempts to 3/min/IP — the 4th within the window is 429', async () => {
    state.pairCode = undefined; // every attempt 401s on validity, but must still count against the limiter
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push((await claim({ code: '000000', deviceLabel: 'Device' })).statusCode);
    }
    expect(results.slice(0, 3)).toEqual([401, 401, 401]);
    expect(results[3]).toBe(429);
  });

  it('the global backstop still 429s a brute-force spread across distinct IPs — the per-IP bucket alone cannot catch it', async () => {
    state.pairCode = undefined; // every attempt fails, but must still count against the global backstop
    const nowMs = Date.now();
    // Seed the backstop to one below capacity directly — equivalent to
    // CLAIM_RATE_LIMIT_GLOBAL - 1 prior failed guesses from distinct,
    // unrelated IPs — instead of looping a few hundred HTTP requests for
    // what the pure-function tests below already cover on their own.
    for (let i = 0; i < CLAIM_RATE_LIMIT_GLOBAL - 1; i++) {
      recordClaimFailureGlobal(claimAttemptsGlobal, nowMs);
    }
    const results: number[] = [];
    // A fresh IP every request is exactly what a spoofed X-Forwarded-For
    // buys an attacker in production (trustProxy: true) — the per-IP
    // limiter alone would let every single one of these through.
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/mobile/pair/claim',
        remoteAddress: `10.0.0.${i}`,
        payload: { code: '000000', deviceLabel: 'Device' },
      });
      results.push(res.statusCode);
    }
    // The CLAIM_RATE_LIMIT_GLOBALth failed attempt still has room (401 on
    // the invalid code, which itself pushes the bucket to capacity); the
    // next one is over capacity (429).
    expect(results[0]).toBe(401);
    expect(results[1]).toBe(429);
  });

  it('a successful claim does not consume the global backstop budget', async () => {
    state.pairCode = { userId: USER_ID, usedAt: null, expiresAt: new Date(Date.now() + 60_000) };
    state.user = { id: USER_ID, orgId: ORG_ID, displayName: 'Jane Rep' };
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/mobile/pair/claim',
        remoteAddress: `10.1.0.${i}`,
        payload: { code: '123456', deviceLabel: 'Device' },
      });
      expect(res.statusCode).toBe(200);
    }
    // Five successful pairings, zero entries recorded against the shared
    // budget — a legitimate burst can never itself trip the backstop.
    expect(claimAttemptsGlobal.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// End to end: the token claim mints is the SAME token that authenticates the
// feed — proving the header wiring between the two endpoints, not just that
// each 200s in isolation off a canned fixture.
// ---------------------------------------------------------------------------
describe('pairing end to end: claim mints a device whose token then reads the feed', () => {
  it('the exact deviceToken returned by claim authenticates the feed request', async () => {
    state.pairCode = { userId: USER_ID, usedAt: null, expiresAt: new Date(Date.now() + 60_000) };
    state.user = { id: USER_ID, orgId: ORG_ID, displayName: 'Jane Rep' };

    const claimRes = await app.inject({
      method: 'POST',
      url: '/mobile/pair/claim',
      payload: { code: '123456', deviceLabel: "Jane's iPhone" },
    });
    expect(claimRes.statusCode).toBe(200);
    const { deviceToken } = claimRes.json();
    expect(typeof deviceToken).toBe('string');

    // The feed's device lookup is a fresh DB round-trip (state.device is
    // what it "finds"); the point under test is that the Authorization
    // header built from claim's response reaches the feed route intact.
    state.device = { id: 'dev-1', userId: USER_ID, revokedAt: null };
    state.latestVersion = { version: 2, entryCount: 1 };
    state.entries = [{ e164: '+16195550100', label: 'Lead: A' }];

    const feedRes = await app.inject({
      method: 'GET',
      url: '/mobile/caller-directory',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(feedRes.statusCode).toBe(200);
    expect(feedRes.json().entries).toEqual([{ e164: '+16195550100', label: 'Lead: A' }]);
  });
});

// ---------------------------------------------------------------------------
// GET /mobile/caller-directory
// ---------------------------------------------------------------------------
describe('GET /mobile/caller-directory', () => {
  function feed(qs = '', token = 'devicetok') {
    return app.inject({
      method: 'GET',
      url: `/mobile/caller-directory${qs}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }

  it('401s with no bearer token', async () => {
    const res = await feed('', '');
    expect(res.statusCode).toBe(401);
  });

  it('401s when the device token does not resolve to any device', async () => {
    state.device = undefined;
    const res = await feed();
    expect(res.statusCode).toBe(401);
  });

  it('401s a revoked device', async () => {
    state.device = { id: 'dev-1', userId: USER_ID, revokedAt: new Date() };
    state.user = { id: USER_ID, orgId: ORG_ID, displayName: 'Jane Rep' };
    const res = await feed();
    expect(res.statusCode).toBe(401);
  });

  it('returns { version, unchanged: true } when since equals the latest version', async () => {
    state.device = { id: 'dev-1', userId: USER_ID, revokedAt: null };
    state.user = { id: USER_ID, orgId: ORG_ID, displayName: 'Jane Rep' };
    state.latestVersion = { version: 3, entryCount: 2 };
    const res = await feed('?since=3');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: 3, unchanged: true });
  });

  it('does a full resync (not unchanged) when since is less than the latest version', async () => {
    state.device = { id: 'dev-1', userId: USER_ID, revokedAt: null };
    state.user = { id: USER_ID, orgId: ORG_ID, displayName: 'Jane Rep' };
    state.latestVersion = { version: 3, entryCount: 1 };
    state.entries = [{ e164: '+16195550100', label: 'Lead: A' }];
    const res = await feed('?since=1');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.unchanged).toBeUndefined();
    expect(body.version).toBe(3);
    expect(body.entries).toEqual([{ e164: '+16195550100', label: 'Lead: A' }]);
  });

  it('pages ascending by the NUMERIC value of e164, not lexicographic text order', async () => {
    state.device = { id: 'dev-1', userId: USER_ID, revokedAt: null };
    state.user = { id: USER_ID, orgId: ORG_ID, displayName: 'Jane Rep' };
    state.latestVersion = { version: 1, entryCount: 2 };
    // Text order puts "+15550000000" before "+25550000" (the second character
    // '1' < '2'). Numeric order is the reverse: 25,550,000 < 15,550,000,000.
    state.entries = [
      { e164: '+15550000000', label: 'Big' },
      { e164: '+25550000', label: 'Small' },
    ];
    const res = await feed();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries.map((e: { e164: string }) => e.e164)).toEqual(['+25550000', '+15550000000']);
    expect(body.page).toBe(1);
    expect(body.pageCount).toBe(1);
  });

  it('returns an empty page when no directory has been published yet', async () => {
    state.device = { id: 'dev-1', userId: USER_ID, revokedAt: null };
    state.user = { id: USER_ID, orgId: ORG_ID, displayName: 'Jane Rep' };
    state.latestVersion = undefined;
    const res = await feed();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: 0, page: 1, pageCount: 0, entries: [] });
  });

  it('honors an explicit page param', async () => {
    state.device = { id: 'dev-1', userId: USER_ID, revokedAt: null };
    state.user = { id: USER_ID, orgId: ORG_ID, displayName: 'Jane Rep' };
    state.latestVersion = { version: 1, entryCount: 1 };
    state.entries = [{ e164: '+16195550100', label: 'A' }];
    const res = await feed('?page=2');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.page).toBe(2);
    expect(body.entries).toEqual([]); // page 2 is past the end of a 1-entry directory
  });

  it('resolves the device from the token hash and bumps last_seen_at (no crash on the presence stamp)', async () => {
    state.device = { id: 'dev-1', userId: USER_ID, revokedAt: null };
    state.user = { id: USER_ID, orgId: ORG_ID, displayName: 'Jane Rep' };
    state.latestVersion = undefined;
    const res = await feed();
    expect(res.statusCode).toBe(200);
    expect(state.lastUpdateValues).toHaveProperty('lastSeenAt');
  });
});

// ---------------------------------------------------------------------------
// POST /mobile/apns-token
// ---------------------------------------------------------------------------
describe('POST /mobile/apns-token', () => {
  it('requires device auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/mobile/apns-token', payload: { token: 'abc' } });
    expect(res.statusCode).toBe(401);
  });

  it('400s a missing token', async () => {
    state.device = { id: 'dev-1', userId: USER_ID, revokedAt: null };
    const res = await app.inject({
      method: 'POST',
      url: '/mobile/apns-token',
      headers: { authorization: 'Bearer devicetok' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('stores the token for the resolved device', async () => {
    state.device = { id: 'dev-1', userId: USER_ID, revokedAt: null };
    const res = await app.inject({
      method: 'POST',
      url: '/mobile/apns-token',
      headers: { authorization: 'Bearer devicetok' },
      payload: { token: 'apns-push-token-abc' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(state.lastUpdateValues).toEqual({ apnsToken: 'apns-push-token-abc' });
  });
});

// ---------------------------------------------------------------------------
// GET /mobile/devices
// ---------------------------------------------------------------------------
describe('GET /mobile/devices', () => {
  it('requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/mobile/devices' });
    expect(res.statusCode).toBe(401);
  });

  it("returns the caller's paired devices", async () => {
    state.authedUser = { userId: USER_ID, orgId: ORG_ID, email: 'rep@example.com', isAdmin: false };
    const createdAt = new Date('2026-08-01T00:00:00Z');
    const lastSeenAt = new Date('2026-08-20T00:00:00Z');
    state.devicesList = [{ id: 'dev-1', label: "Jane's iPhone", createdAt, lastSeenAt }];
    const res = await app.inject({ method: 'GET', url: '/mobile/devices', headers: { authorization: 'Bearer tok' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      devices: [{ id: 'dev-1', label: "Jane's iPhone", createdAt: createdAt.toISOString(), lastSeenAt: lastSeenAt.toISOString() }],
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /mobile/devices/:id
// ---------------------------------------------------------------------------
describe('DELETE /mobile/devices/:id', () => {
  it('requires a session', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/mobile/devices/dev-1' });
    expect(res.statusCode).toBe(401);
  });

  it('404s a device that does not exist or is not owned by the caller', async () => {
    state.authedUser = { userId: USER_ID, orgId: ORG_ID, email: 'rep@example.com', isAdmin: false };
    state.device = undefined;
    const res = await app.inject({ method: 'DELETE', url: '/mobile/devices/dev-1', headers: { authorization: 'Bearer tok' } });
    expect(res.statusCode).toBe(404);
  });

  it('revokes an owned device', async () => {
    state.authedUser = { userId: USER_ID, orgId: ORG_ID, email: 'rep@example.com', isAdmin: false };
    state.device = { id: 'dev-1', userId: USER_ID, revokedAt: null };
    const res = await app.inject({ method: 'DELETE', url: '/mobile/devices/dev-1', headers: { authorization: 'Bearer tok' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(state.lastUpdateValues).toHaveProperty('revokedAt');
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe('allowClaimAttempt', () => {
  it('allows up to the limit, then refuses within the same window', () => {
    const map = new Map<string, number[]>();
    const now = 1_000_000;
    expect(allowClaimAttempt(map, '1.2.3.4', now)).toBe(true);
    expect(allowClaimAttempt(map, '1.2.3.4', now + 1)).toBe(true);
    expect(allowClaimAttempt(map, '1.2.3.4', now + 2)).toBe(true);
    expect(allowClaimAttempt(map, '1.2.3.4', now + 3)).toBe(false);
  });

  it('tracks each IP independently', () => {
    const map = new Map<string, number[]>();
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) allowClaimAttempt(map, 'ip-a', now);
    expect(allowClaimAttempt(map, 'ip-b', now)).toBe(true);
  });

  it('lets an IP back in once the window has rolled past', () => {
    const map = new Map<string, number[]>();
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) allowClaimAttempt(map, '1.2.3.4', now);
    expect(allowClaimAttempt(map, '1.2.3.4', now + 61_000)).toBe(true);
  });

  it('sweeps stale keys out of the map entirely (bounds memory against a spoofed value per request)', () => {
    const map = new Map<string, number[]>();
    const now = 1_000_000;
    // Simulate an attacker cycling a fresh IP per request: each key is
    // visited exactly once and never revisited, so nothing would ever prune
    // it except a sweep that looks at every key, not just the current one.
    for (let i = 0; i < 50; i++) allowClaimAttempt(map, `spoofed-${i}`, now + i);
    expect(map.size).toBe(50);
    // Once the whole window has rolled past, the next call — for ANY key —
    // must sweep every stale entry out, not just record its own.
    allowClaimAttempt(map, 'spoofed-999', now + 61_000);
    expect(map.size).toBe(1);
    expect(map.has('spoofed-999')).toBe(true);
  });
});

describe('globalBudgetAvailable / recordClaimFailureGlobal', () => {
  it('has room until the cap, then reports no room within the same window, regardless of caller identity', () => {
    const bucket: number[] = [];
    const now = 1_000_000;
    for (let i = 0; i < CLAIM_RATE_LIMIT_GLOBAL; i++) {
      expect(globalBudgetAvailable(bucket, now + i)).toBe(true);
      recordClaimFailureGlobal(bucket, now + i);
    }
    expect(globalBudgetAvailable(bucket, now + CLAIM_RATE_LIMIT_GLOBAL)).toBe(false);
  });

  it('checking availability alone never consumes budget — only recordClaimFailureGlobal does', () => {
    const bucket: number[] = [];
    const now = 1_000_000;
    for (let i = 0; i < 1000; i++) globalBudgetAvailable(bucket, now);
    expect(bucket.length).toBe(0);
    expect(globalBudgetAvailable(bucket, now)).toBe(true);
  });

  it('lets the bucket back in once the window has rolled past', () => {
    const bucket: number[] = [];
    const now = 1_000_000;
    for (let i = 0; i < CLAIM_RATE_LIMIT_GLOBAL; i++) recordClaimFailureGlobal(bucket, now + i);
    expect(globalBudgetAvailable(bucket, now + 61_000)).toBe(true);
  });
});

describe('pairCodeClaimable', () => {
  const now = new Date('2026-08-25T12:00:00Z');
  it('is false for no row', () => {
    expect(pairCodeClaimable(undefined, now)).toBe(false);
  });
  it('is false once used', () => {
    expect(pairCodeClaimable({ usedAt: now, expiresAt: new Date(now.getTime() + 1000) }, now)).toBe(false);
  });
  it('is false once expired (exactly at expiry counts as expired)', () => {
    expect(pairCodeClaimable({ usedAt: null, expiresAt: now }, now)).toBe(false);
  });
  it('is true when unused and not yet expired', () => {
    expect(pairCodeClaimable({ usedAt: null, expiresAt: new Date(now.getTime() + 1000) }, now)).toBe(true);
  });
});

describe('sortEntriesByDigits', () => {
  it('sorts by the numeric value of the digits, not the text', () => {
    const sorted = sortEntriesByDigits([
      { e164: '+15550000000' },
      { e164: '+25550000' },
      { e164: '+299' },
    ]);
    expect(sorted.map((e) => e.e164)).toEqual(['+299', '+25550000', '+15550000000']);
  });

  it('is stable for equal keys', () => {
    const a = { e164: '+16195550100', tag: 'a' };
    const b = { e164: '+16195550100', tag: 'b' };
    expect(sortEntriesByDigits([a, b])).toEqual([a, b]);
  });
});

describe('paginate', () => {
  it('splits at the page boundary and reports pageCount', () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const page1 = paginate(items, 1, 10);
    expect(page1.entries).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(page1.pageCount).toBe(3);
    const page3 = paginate(items, 3, 10);
    expect(page3.entries).toEqual([20, 21, 22, 23, 24]);
  });

  it('is empty (not an error) past the last page', () => {
    const page = paginate([1, 2, 3], 5, 10);
    expect(page.entries).toEqual([]);
    expect(page.pageCount).toBe(1);
  });

  it('reports pageCount 1 for an empty directory', () => {
    expect(paginate([], 1, 10).pageCount).toBe(1);
  });
});

describe('generatePairCode', () => {
  it('always returns 6 digits, zero-padded', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePairCode()).toMatch(/^\d{6}$/);
    }
  });
});
