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
  // The `where` predicate the claim's atomic UPDATE was actually issued
  // with, so a test can assert the rule lives in the SQL and not in a
  // read-then-write window.
  lastPairCodeClaimWhere: null as unknown,
  // Force the claim UPDATE to match zero rows even though `pairCode` looks
  // claimable — i.e. a concurrent claimant won the race between the two.
  pairCodeClaimLost: false,
  deviceInsertCount: 0,
  // The `where` predicates the routes actually handed the database, so the
  // scoping tests below assert what was MATCHED rather than what the fixture
  // happened to hold. Without these the fake returns its single fixture for
  // any query, so dropping the token-hash lookup, the ownership scope, or the
  // org scope would still pass every other test in this file.
  lastDeviceFindWhere: null as unknown,
  lastDevicesListWhere: null as unknown,
  lastDirectoryVersionsWhere: null as unknown,
  lastDirectoryEntriesWhere: null as unknown,
  // The exact values `/mobile/register` handed to `insert(mobileDevices).values(...)`,
  // so tests can assert the row actually written (userId scoping, hash-at-rest)
  // rather than trusting the response body alone.
  lastDeviceInsertValues: null as Record<string, unknown> | null,
}));

vi.mock('../auth/session.js', () => ({
  resolveSession: async (_bearer: string | undefined) => state.authedUser,
}));

vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return { ...actual, getDb: () => fakeDb() };
});

import { schema } from '@cti/db';
import { sha256 } from '../crypto.js';
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
 * Renders a drizzle `where` predicate to readable SQL-ish text so a test can
 * assert what the database was actually asked to match, rather than trusting
 * a JS-side check the database never saw. Walks the same `queryChunks` shape
 * `dialer-handoffs.test.ts` introspects for its advisory-lock assertions:
 * a chunk is either a nested `SQL`, a literal `StringChunk` (`{ value: [...] }`),
 * a `Column` (has `.name` + `.table`), or a bound `Param` (`{ value }`).
 */
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

/**
 * Just enough of the drizzle surface mobile.ts touches.
 *
 * `update(...).set(...).where(...)` returns a thenable (so the fire-and-forget
 * device updates — `lastSeenAt`, `apnsToken`, `revokedAt` — still work when
 * plainly awaited) that ALSO exposes `.returning()`, which the pair-code claim
 * chains. For `mobilePairCodes` that `.returning()` emulates what Postgres
 * would do with the claim's WHERE: it applies `pairCodeClaimable` (the same
 * documented rule the SQL encodes) to the configured fixture, so a used or
 * expired fixture matches zero rows — exactly as the real single-statement
 * claim would. `pairCodeClaimLost` forces zero rows regardless, standing in
 * for a concurrent claimant that won the race.
 *
 * `insert(...).values(...)` likewise returns a thenable (the `mobileDevices`
 * insert awaits it directly) that exposes `.onConflictDoNothing().returning()`
 * — the `mobilePairCodes` insert's retry-on-collision path — resolving to `[]`
 * for `pairCodeInsertConflictsRemaining` calls (simulating a codeHash
 * collision) before "succeeding" with an inserted row.
 */
function fakeDb() {
  return {
    query: {
      mobilePairCodes: { findFirst: async () => state.pairCode },
      mobileDevices: {
        findFirst: async (config?: { where?: unknown }) => {
          state.lastDeviceFindWhere = config?.where;
          return state.device;
        },
        findMany: async (config?: { where?: unknown }) => {
          state.lastDevicesListWhere = config?.where;
          return state.devicesList;
        },
      },
      users: { findFirst: async () => state.user },
      callerDirectoryVersions: {
        findFirst: async (config?: { where?: unknown }) => {
          state.lastDirectoryVersionsWhere = config?.where;
          return state.latestVersion;
        },
      },
      callerDirectoryEntries: {
        findMany: async (config?: { where?: unknown }) => {
          state.lastDirectoryEntriesWhere = config?.where;
          return state.entries;
        },
      },
    },
    delete(_table: unknown) {
      return { where: async () => { state.deletedPairCodes = true; } };
    },
    insert(table: unknown) {
      return {
        values: (values: Record<string, unknown>) => {
          if (table === schema.mobileDevices) {
            state.deviceInsertCount++;
            state.lastDeviceInsertValues = values;
          }
          const thenable = Promise.resolve(undefined) as Promise<void> & {
            onConflictDoNothing: () => { returning: () => Promise<Array<Record<string, unknown>>> };
            returning: (selection?: unknown) => Promise<Array<Record<string, unknown>>>;
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
          // `/mobile/register`'s device insert (unlike claim's, which is
          // fire-and-forget) needs the inserted row's id back directly —
          // no onConflictDoNothing in its path.
          thenable.returning = async () => {
            if (table === schema.mobileDevices) return [{ id: 'device-1', ...values }];
            return [{ ...values }];
          };
          return thenable;
        },
      };
    },
    update(table: unknown) {
      return {
        set: (values: Record<string, unknown>) => ({
          where: (predicate: unknown) => {
            state.updateCallCount++;
            state.lastUpdateValues = values;
            if (table === schema.mobilePairCodes) state.lastPairCodeClaimWhere = predicate;
            const thenable = Promise.resolve(undefined) as Promise<void> & {
              returning: () => Promise<Array<Record<string, unknown>>>;
            };
            thenable.returning = async () => {
              if (table !== schema.mobilePairCodes) return [];
              if (state.pairCodeClaimLost) return [];
              return pairCodeClaimable(state.pairCode, new Date()) ? [{ ...state.pairCode }] : [];
            };
            return thenable;
          },
        }),
      };
    },
  } as unknown as ReturnType<typeof import('@cti/db').getDb>;
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
  state.lastPairCodeClaimWhere = null;
  state.pairCodeClaimLost = false;
  state.deviceInsertCount = 0;
  state.lastDeviceInsertValues = null;
  state.lastDeviceFindWhere = null;
  state.lastDevicesListWhere = null;
  state.lastDirectoryVersionsWhere = null;
  state.lastDirectoryEntriesWhere = null;
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

  it('claims with ONE atomic UPDATE whose predicate carries the whole single-use rule', async () => {
    state.pairCode = { userId: USER_ID, usedAt: null, expiresAt: new Date(Date.now() + 60_000) };
    state.user = { id: USER_ID, orgId: ORG_ID, displayName: 'Jane Rep' };
    const res = await claim({ code: '123456', deviceLabel: "Jane's iPhone" });
    expect(res.statusCode).toBe(200);

    // Single-use has to be enforced by the database in the same statement that
    // marks the code used — a separate read, then a validate, then an UPDATE
    // lets N concurrent claimants of one leaked code all pass validation and
    // all mint a device. Assert the rule is in the SQL, not in a JS window:
    const predicate = renderPredicate(state.lastPairCodeClaimWhere);
    expect(predicate).toContain('code_hash =');
    expect(predicate).toContain('used_at is null');
    expect(predicate).toContain('expires_at >');
    // …and that the three are ANDed. Without this the same three substrings
    // are present in an `or(...)` of them, which would let ANY random 6-digit
    // POST match an already-used or long-expired row and mint a token bound
    // to somebody else's account.
    expect(predicate).toContain(' and ');
    expect(predicate).not.toContain(' or ');
  });

  it('401s and mints NO device when the atomic claim matches no row (a concurrent claimant won)', async () => {
    // The fixture would have passed a read-then-validate check — unused and
    // unexpired — but the UPDATE matches zero rows because another in-flight
    // request already flipped `used_at` first. Exactly the race the atomic
    // claim exists to lose safely.
    state.pairCode = { userId: USER_ID, usedAt: null, expiresAt: new Date(Date.now() + 60_000) };
    state.user = { id: USER_ID, orgId: ORG_ID, displayName: 'Jane Rep' };
    state.pairCodeClaimLost = true;

    const res = await claim({ code: '123456', deviceLabel: "Jane's iPhone" });
    expect(res.statusCode).toBe(401);
    expect(state.deviceInsertCount).toBe(0);
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
    // A fresh IP every request is what a botnet (or any pool of source
    // addresses) buys an attacker even with `trustProxy: 1` pinning req.ip
    // to what the edge observed — the per-IP limiter alone, three guesses
    // per address, would let every single one of these through.
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

  it('a request refused by the global backstop never touches the per-IP map', async () => {
    state.pairCode = undefined;
    const nowMs = Date.now();
    // The global backstop is already at capacity — everything below is 429.
    for (let i = 0; i < CLAIM_RATE_LIMIT_GLOBAL; i++) recordClaimFailureGlobal(claimAttemptsGlobal, nowMs);

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/mobile/pair/claim',
        remoteAddress: `10.2.0.${i}`,
        payload: { code: '000000', deviceLabel: 'Device' },
      });
      expect(res.statusCode).toBe(429);
    }
    // The global check runs FIRST, so a flood already being refused globally
    // can neither grow the per-IP map (unbounded memory under a spoofed
    // X-Forwarded-For per request) nor burn a legitimate IP's 3 slots.
    expect(claimAttemptsByIp.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// POST /mobile/register
// ---------------------------------------------------------------------------
describe('POST /mobile/register', () => {
  it('mints a device token for the signed-in user', async () => {
    const sessionUserId = 'u1';
    state.authedUser = { userId: sessionUserId, orgId: 'o1', email: 'rep@x.com', isAdmin: false };
    const res = await app.inject({ method: 'POST', url: '/mobile/register', headers: { authorization: 'Bearer session' }, payload: { deviceLabel: 'iPhone (Callsign)' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.deviceToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(body.deviceId).toBeTruthy();
    expect(state.deviceInsertCount).toBe(1);
    // The inserted row must be scoped to the SESSION's user (not any
    // client-suppliable value) and must store a hash of the token, never
    // the raw token itself — otherwise a DB read (or leak) at rest would
    // hand out live device credentials.
    const v = state.lastDeviceInsertValues as { tokenHash: string; userId: string; label: string };
    expect(v.userId).toBe(sessionUserId);
    expect(v.tokenHash).not.toBe(body.deviceToken);
    expect(v.tokenHash).toBe(sha256(body.deviceToken));
  });
  it('401 without a session', async () => {
    state.authedUser = null;
    const res = await app.inject({ method: 'POST', url: '/mobile/register', headers: { authorization: 'Bearer x' }, payload: { deviceLabel: 'iPhone' } });
    expect(res.statusCode).toBe(401);
  });
  it('400 on a missing label', async () => {
    state.authedUser = { userId: 'u1', orgId: 'o1', email: 'rep@x.com', isAdmin: false };
    const res = await app.inject({ method: 'POST', url: '/mobile/register', headers: { authorization: 'Bearer session' }, payload: {} });
    expect(res.statusCode).toBe(400);
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

  it('asks the database for the device BY TOKEN HASH — the auth is in the where clause, not in the fixture', async () => {
    // The fake returns `state.device` for any query, so every other test here
    // would still pass if the lookup dropped its predicate entirely and
    // authenticated the first device row in the table. Assert what the
    // database was actually asked to match.
    state.device = { id: 'dev-1', userId: USER_ID, revokedAt: null };
    state.user = { id: USER_ID, orgId: ORG_ID, displayName: 'Jane Rep' };
    const res = await feed();
    expect(res.statusCode).toBe(200);
    expect(renderPredicate(state.lastDeviceFindWhere)).toContain('token_hash =');
  });

  it('scopes both directory reads to the device holder\'s org (and the entries to the latest version)', async () => {
    // Cross-tenant: a device token belongs to a user, the user to an org, and
    // the directory is org-wide CRM data. Dropping either org_id here would
    // serve another org's names and numbers to this phone, and every
    // assertion above would still be green because the fake answers
    // unconditionally.
    state.device = { id: 'dev-1', userId: USER_ID, revokedAt: null };
    state.user = { id: USER_ID, orgId: ORG_ID, displayName: 'Jane Rep' };
    state.latestVersion = { version: 3, entryCount: 1 };
    state.entries = [{ e164: '+16195550100', label: 'Lead: A' }];

    const res = await feed();
    expect(res.statusCode).toBe(200);

    expect(renderPredicate(state.lastDirectoryVersionsWhere)).toContain('org_id =');
    const entriesWhere = renderPredicate(state.lastDirectoryEntriesWhere);
    expect(entriesWhere).toContain('org_id =');
    expect(entriesWhere).toContain('version =');
    expect(entriesWhere).toContain(' and ');
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

  it('400s an absurdly long token instead of storing it unbounded', async () => {
    state.device = { id: 'dev-1', userId: USER_ID, revokedAt: null };
    const res = await app.inject({
      method: 'POST',
      url: '/mobile/apns-token',
      headers: { authorization: 'Bearer devicetok' },
      payload: { token: 'a'.repeat(4097) },
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
// POST /mobile/voip-token
// ---------------------------------------------------------------------------
describe('POST /mobile/voip-token', () => {
  it('requires device auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/mobile/voip-token', payload: { token: 'voip-push-token-abcdef' } });
    expect(res.statusCode).toBe(401);
  });

  it('400s a missing token', async () => {
    state.device = { id: 'dev-1', userId: USER_ID, revokedAt: null };
    const res = await app.inject({
      method: 'POST',
      url: '/mobile/voip-token',
      headers: { authorization: 'Bearer devicetok' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s an absurdly long token instead of storing it unbounded', async () => {
    state.device = { id: 'dev-1', userId: USER_ID, revokedAt: null };
    const res = await app.inject({
      method: 'POST',
      url: '/mobile/voip-token',
      headers: { authorization: 'Bearer devicetok' },
      payload: { token: 'a'.repeat(513) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400s a token shorter than a real PushKit token', async () => {
    state.device = { id: 'dev-1', userId: USER_ID, revokedAt: null };
    const res = await app.inject({
      method: 'POST',
      url: '/mobile/voip-token',
      headers: { authorization: 'Bearer devicetok' },
      payload: { token: 'a'.repeat(15) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('stores the token for the resolved device', async () => {
    state.device = { id: 'dev-1', userId: USER_ID, revokedAt: null };
    const res = await app.inject({
      method: 'POST',
      url: '/mobile/voip-token',
      headers: { authorization: 'Bearer devicetok' },
      payload: { token: 'voip-push-token-abcdef' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(state.lastUpdateValues).toEqual({ voipToken: 'voip-push-token-abcdef' });
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

  it('lists only the CALLER\'S still-active devices — the scope is in the where clause', async () => {
    state.authedUser = { userId: USER_ID, orgId: ORG_ID, email: 'rep@example.com', isAdmin: false };
    const res = await app.inject({ method: 'GET', url: '/mobile/devices', headers: { authorization: 'Bearer tok' } });
    expect(res.statusCode).toBe(200);
    const predicate = renderPredicate(state.lastDevicesListWhere);
    expect(predicate).toContain('user_id =');
    expect(predicate).toContain('revoked_at is null');
    expect(predicate).toContain(' and ');
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

  it('looks the device up scoped to the caller — id AND user_id, never id alone (IDOR)', async () => {
    // The 404 test above passes with an unscoped `where eq(id)` too, because
    // the fake simply returns whatever fixture the test set. The ownership
    // check only actually exists if the database is the one enforcing it:
    // without user_id in this predicate, any rep could revoke any other rep's
    // phone by guessing a device id.
    state.authedUser = { userId: USER_ID, orgId: ORG_ID, email: 'rep@example.com', isAdmin: false };
    state.device = { id: 'dev-1', userId: USER_ID, revokedAt: null };
    await app.inject({ method: 'DELETE', url: '/mobile/devices/dev-1', headers: { authorization: 'Bearer tok' } });
    const predicate = renderPredicate(state.lastDeviceFindWhere);
    expect(predicate).toContain('id =');
    expect(predicate).toContain('user_id =');
    expect(predicate).toContain(' and ');
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

  it('breaks ties on the e164 text so equal digit-values page deterministically', () => {
    // Same digits, different text — without a tiebreaker their relative order
    // would follow whatever order the DB happened to return them in, so a
    // client paging through the feed could see one of them twice and the
    // other never.
    const plus = { e164: '+16195550100' };
    const bare = { e164: '16195550100' };
    expect(sortEntriesByDigits([plus, bare]).map((e) => e.e164)).toEqual(['+16195550100', '16195550100']);
    expect(sortEntriesByDigits([bare, plus]).map((e) => e.e164)).toEqual(['+16195550100', '16195550100']);
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
