import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  session: undefined as Record<string, unknown> | undefined,
  user: undefined as Record<string, unknown> | undefined,
  org: undefined as Record<string, unknown> | undefined,
  inserted: [] as Array<Record<string, unknown>>,
  /** Every findFirst, in order — pins that the detail costs no extra query. */
  lookups: [] as string[],
  lastUpdateTable: null as unknown,
  lastUpdateValues: null as Record<string, unknown> | null,
  lastUpdateWhere: null as unknown,
}));

vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  const db = {
    query: {
      sessions: { findFirst: async () => { state.lookups.push('sessions'); return state.session; } },
      users: { findFirst: async () => { state.lookups.push('users'); return state.user; } },
      organizations: { findFirst: async () => { state.lookups.push('organizations'); return state.org; } },
    },
    insert: () => ({ values: async (v: Record<string, unknown>) => { state.inserted.push(v); } }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async (predicate: unknown) => {
          state.lastUpdateTable = table;
          state.lastUpdateValues = values;
          state.lastUpdateWhere = predicate;
        },
      }),
    }),
  };
  return { ...actual, getDb: () => db };
});

import { schema } from '@cti/db';
import { sha256 } from './crypto.js';
import {
  isCtiResetDue,
  issueSession,
  resolveSession,
  resolveSessionDetail,
  revokeAllSessionsForUser,
  revokeSession,
  ServiceUserSessionError,
  SuspendedTenantError,
} from './session.js';

/**
 * Renders a drizzle `where` predicate to readable SQL-ish text, copied from
 * the same helper in services/cti-api/src/routes/mobile.test.ts, so a test
 * can assert what the database was actually asked to match rather than
 * trusting a JS-side check the database never saw.
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

const human = { id: 'U1', orgId: 'O1', email: 'rep@example.com', isAdmin: false, powerDialerEnabled: true, kind: 'human', isSuperAdmin: false };
const service = { ...human, id: 'AI', email: 'ai-agent@gg-homes.internal', kind: 'service' };
const ISSUED = new Date('2026-09-28T20:00:00.000Z');

beforeEach(() => {
  state.session = { userId: 'U1', tokenHash: 'h', expiresAt: new Date(Date.now() + 60_000), revokedAt: null };
  state.user = human;
  state.org = { status: 'active' };
  state.inserted = [];
  state.lookups = [];
  state.lastUpdateTable = null;
  state.lastUpdateValues = null;
  state.lastUpdateWhere = null;
});

describe('resolveSession', () => {
  it('returns the user with kind and isSuperAdmin', async () => {
    await expect(resolveSession('Bearer tok')).resolves.toEqual({
      userId: 'U1', orgId: 'O1', email: 'rep@example.com', isAdmin: false, powerDialerEnabled: true, kind: 'human', isSuperAdmin: false,
    });
  });
  it('returns null for a service user even with a valid session row', async () => {
    state.user = service;
    await expect(resolveSession('Bearer tok')).resolves.toBeNull();
  });
  it('returns null without a bearer or with an unknown token', async () => {
    await expect(resolveSession(undefined)).resolves.toBeNull();
    state.session = undefined;
    await expect(resolveSession('Bearer nope')).resolves.toBeNull();
  });
  it('returns null when the tenant is suspended', async () => {
    state.org = { status: 'suspended' };
    await expect(resolveSession('Bearer tok')).resolves.toBeNull();
  });
  it('returns null when the tenant row is missing', async () => {
    state.org = undefined;
    await expect(resolveSession('Bearer tok')).resolves.toBeNull();
  });
});

describe('resolveSessionDetail — what Reset CTI needs, from the same two rows', () => {
  it("returns the user plus this session's created_at and the user's reset request", async () => {
    const requested = new Date('2026-09-28T21:00:00.000Z');
    state.session = { ...state.session, createdAt: ISSUED };
    state.user = { ...human, ctiResetRequestedAt: requested };
    await expect(resolveSessionDetail('Bearer tok')).resolves.toEqual({
      user: { userId: 'U1', orgId: 'O1', email: 'rep@example.com', isAdmin: false, powerDialerEnabled: true, kind: 'human', isSuperAdmin: false },
      sessionCreatedAt: ISSUED,
      ctiResetRequestedAt: requested,
    });
  });
  it('a user nobody ever reset reads null', async () => {
    state.session = { ...state.session, createdAt: ISSUED };
    state.user = { ...human, ctiResetRequestedAt: null };
    expect((await resolveSessionDetail('Bearer tok'))?.ctiResetRequestedAt).toBeNull();
  });
  it('costs exactly what resolveSession costs: one session, one user, one tenant lookup', async () => {
    state.session = { ...state.session, createdAt: ISSUED };
    await resolveSessionDetail('Bearer tok');
    expect(state.lookups).toEqual(['sessions', 'users', 'organizations']);
    state.lookups = [];
    await resolveSession('Bearer tok');
    expect(state.lookups).toEqual(['sessions', 'users', 'organizations']);
  });
  it('the same gates as resolveSession: no bearer, service user, suspended tenant, unknown token → null', async () => {
    await expect(resolveSessionDetail(undefined)).resolves.toBeNull();
    state.user = service;
    await expect(resolveSessionDetail('Bearer tok')).resolves.toBeNull();
    state.user = human;
    state.org = { status: 'suspended' };
    await expect(resolveSessionDetail('Bearer tok')).resolves.toBeNull();
    state.org = { status: 'active' };
    state.session = undefined;
    await expect(resolveSessionDetail('Bearer nope')).resolves.toBeNull();
  });
});

describe('isCtiResetDue — due when the reset was asked for after the session was issued', () => {
  it('never asked → not due', () => {
    expect(isCtiResetDue(null, ISSUED)).toBe(false);
  });
  it('asked after this session was issued → due', () => {
    expect(isCtiResetDue(new Date('2026-09-28T20:00:00.001Z'), ISSUED)).toBe(true);
  });
  it('asked before this session (the rep already signed in again) → not due: no reset loop', () => {
    expect(isCtiResetDue(new Date('2026-09-28T19:59:59.999Z'), ISSUED)).toBe(false);
  });
  it('asked at the very instant the session was issued → not due', () => {
    expect(isCtiResetDue(new Date(ISSUED.getTime()), ISSUED)).toBe(false);
  });
});

describe('issueSession', () => {
  it('stores only the sha256 of the token, with a 30-day expiry', async () => {
    const before = Date.now();
    const { token, expiresAt } = await issueSession('U1');
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({ userId: 'U1', tokenHash: sha256(token) });
    expect(expiresAt.getTime() - before).toBeGreaterThan(29 * 24 * 3600 * 1000);
  });
  it('refuses a service user and inserts nothing', async () => {
    state.user = service;
    await expect(issueSession('AI')).rejects.toBeInstanceOf(ServiceUserSessionError);
    expect(state.inserted).toHaveLength(0);
  });
  it('refuses an unknown user', async () => {
    state.user = undefined;
    await expect(issueSession('nope')).rejects.toThrow('Unknown user');
  });
  it('refuses a user whose tenant is suspended and inserts nothing', async () => {
    state.org = { status: 'suspended' };
    await expect(issueSession('U1')).rejects.toBeInstanceOf(SuspendedTenantError);
    expect(state.inserted).toHaveLength(0);
  });
  it('refuses a user whose tenant row is missing', async () => {
    state.org = undefined;
    await expect(issueSession('U1')).rejects.toBeInstanceOf(SuspendedTenantError);
  });
});

describe('revokeSession — the single-session revoke Reset CTI uses', () => {
  it("revokes exactly the caller's token, never every session of the user (the iPhone shares the table)", async () => {
    await revokeSession('Bearer tok');
    expect(state.lastUpdateTable).toBe(schema.sessions);
    expect(state.lastUpdateValues!.revokedAt).toBeInstanceOf(Date);
    expect(renderPredicate(state.lastUpdateWhere)).toBe('token_hash = <param>');
  });
});

describe('revokeAllSessionsForUser', () => {
  it('revokes with ONE update scoped to the user, not a specific token', async () => {
    await revokeAllSessionsForUser('U1');
    expect(state.lastUpdateTable).toBe(schema.sessions);
    expect(state.lastUpdateValues).toHaveProperty('revokedAt');
    expect(state.lastUpdateValues!.revokedAt).toBeInstanceOf(Date);
    const predicate = renderPredicate(state.lastUpdateWhere);
    // Scoped by user_id (every session, any device/browser) AND still-live
    // (revoked_at is null) — never a single token_hash, which is what
    // distinguishes this from the single-session revokeSession(bearer).
    expect(predicate).toContain('user_id =');
    expect(predicate).toContain('revoked_at is null');
    expect(predicate).toContain(' and ');
    expect(predicate).not.toContain('token_hash');
  });
});
