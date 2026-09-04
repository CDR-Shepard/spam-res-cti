import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  session: undefined as Record<string, unknown> | undefined,
  user: undefined as Record<string, unknown> | undefined,
  org: undefined as Record<string, unknown> | undefined,
  inserted: [] as Array<Record<string, unknown>>,
  lastUpdateTable: null as unknown,
  lastUpdateValues: null as Record<string, unknown> | null,
  lastUpdateWhere: null as unknown,
}));

vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  const db = {
    query: {
      sessions: { findFirst: async () => state.session },
      users: { findFirst: async () => state.user },
      organizations: { findFirst: async () => state.org },
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
  issueSession,
  resolveSession,
  revokeAllSessionsForUser,
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

beforeEach(() => {
  state.session = { userId: 'U1', tokenHash: 'h', expiresAt: new Date(Date.now() + 60_000), revokedAt: null };
  state.user = human;
  state.org = { status: 'active' };
  state.inserted = [];
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
