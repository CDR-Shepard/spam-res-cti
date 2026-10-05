import { describe, expect, it, vi } from 'vitest';
import { internalRequestHeaders } from '@cti/auth';
import type { Db } from '../dialer/pick-did.js';
import { INTERNAL_RATE_MAX, checkInternalRequest, checkInternalTransport, internalHostAllowed, internalSession } from './internal-auth.js';

const SECRET = 'q'.repeat(40);
const NOW = new Date('2026-10-05T12:00:00.000Z');
const PROD = { OUTREACH_INTERNAL_SECRET: SECRET, NODE_ENV: 'production' as const };
const PATH = '/internal/ai-calls';
const BODY = '{"a":1}';

function req(headers: Record<string, string | undefined>, over: { method?: string; url?: string; rawBody?: string } = {}) {
  const signed = internalRequestHeaders(SECRET, { method: 'POST', path: PATH, body: BODY }, NOW);
  return {
    method: over.method ?? 'POST',
    url: over.url ?? PATH,
    rawBody: over.rawBody ?? BODY,
    headers: { host: 'ctiapi.railway.internal:4000', ...signed, ...headers },
  };
}

describe('internalHostAllowed', () => {
  it('pins the rate limit', () => {
    expect(INTERNAL_RATE_MAX).toBe(60);
  });

  it.each(['ctiapi.railway.internal', 'ctiapi.railway.internal:4000', 'CTIAPI.RAILWAY.INTERNAL', ' ctiapi.railway.internal '])(
    '1: production allows %s',
    (host) => {
      expect(internalHostAllowed(host, 'production')).toBe(true);
    },
  );

  it.each([
    'api.example.com',
    'ctiapi.railway.internal.evil.com',
    'ctiapi.railway.internal.evil.com:4000',
    '.railway.internal',
    'railway.internal',
    'evilrailway.internal',
    '',
    undefined,
  ])('1: production refuses %s', (host) => {
    expect(internalHostAllowed(host, 'production')).toBe(false);
  });

  it.each(['development', 'test'] as const)('2: %s allows every host', (env) => {
    expect(internalHostAllowed('localhost:4000', env)).toBe(true);
    expect(internalHostAllowed(undefined, env)).toBe(true);
  });
});

describe('checkInternalRequest — guard order', () => {
  it('3a: an unset secret answers 503 even with a bad host', () => {
    const r = req({ host: 'api.example.com' });
    expect(checkInternalRequest(r, { OUTREACH_INTERNAL_SECRET: undefined, NODE_ENV: 'production' }, NOW)).toEqual({
      ok: false,
      status: 503,
      error: 'internal_disabled',
    });
  });

  it('3b: a public host answers 404 in production before the signature is looked at', () => {
    const r = req({ host: 'cti.example.com', 'x-outreach-signature': undefined });
    expect(checkInternalRequest(r, PROD, NOW)).toEqual({ ok: false, status: 404, error: 'not_found' });
  });

  it('3c: any Origin header answers 403, even a signed request from the private network', () => {
    expect(checkInternalRequest(req({ origin: 'https://cti.example.com' }), PROD, NOW)).toEqual({ ok: false, status: 403, error: 'forbidden' });
    expect(checkInternalRequest(req({ origin: '' }), PROD, NOW)).toMatchObject({ status: 403 });
  });

  it('3d: a bad signature answers 401 and says why (for the log)', () => {
    expect(checkInternalRequest(req({}, { rawBody: '{"a":2}' }), PROD, NOW)).toEqual({
      ok: false,
      status: 401,
      error: 'bad_signature',
      reason: 'mismatch',
    });
    expect(checkInternalRequest(req({ 'x-outreach-signature': undefined }), PROD, NOW)).toMatchObject({ status: 401, reason: 'missing' });
    expect(checkInternalRequest(req({}), PROD, new Date(NOW.getTime() + 301_000))).toMatchObject({ status: 401, reason: 'stale' });
  });

  it('3e: a good request passes', () => {
    expect(checkInternalRequest(req({}), PROD, NOW)).toEqual({ ok: true });
    expect(checkInternalRequest(req({ host: 'localhost:4000' }), { ...PROD, NODE_ENV: 'development' }, NOW)).toEqual({ ok: true });
  });

  it('the transport half (secret, host, origin) needs no body', () => {
    expect(checkInternalTransport({ host: 'ctiapi.railway.internal' }, PROD)).toEqual({ ok: true });
    expect(checkInternalTransport({ host: 'cti.example.com' }, PROD)).toEqual({ ok: false, status: 404, error: 'not_found' });
    expect(checkInternalTransport({ host: 'ctiapi.railway.internal', origin: 'x' }, PROD)).toEqual({ ok: false, status: 403, error: 'forbidden' });
  });
});

describe('internalSession', () => {
  const ORG = '99999999-2222-4333-8444-555555555555';
  const USER = '11111111-2222-4333-8444-555555555555';
  const userRow = {
    id: USER,
    orgId: ORG,
    email: 'admin@example.com',
    isAdmin: true,
    powerDialerEnabled: false,
    kind: 'human',
    isSuperAdmin: false,
  };

  function db(user: Record<string, unknown> | undefined, orgStatus: string | undefined) {
    return {
      query: {
        users: { findFirst: vi.fn(async () => user) },
        organizations: { findFirst: vi.fn(async () => (orgStatus ? { status: orgStatus } : undefined)) },
      },
    } as unknown as Db;
  }

  it('4: an active human user of an active org is a SessionUser, isAdmin from the row', async () => {
    expect(await internalSession(db(userRow, 'active'), ORG, USER)).toEqual({
      userId: USER,
      orgId: ORG,
      email: 'admin@example.com',
      isAdmin: true,
      powerDialerEnabled: false,
      kind: 'human',
      isSuperAdmin: false,
    });
    expect((await internalSession(db({ ...userRow, isAdmin: false }, 'active'), ORG, USER))?.isAdmin).toBe(false);
  });

  it.each([
    ['no such user', undefined, 'active'],
    ["another org's user", { ...userRow, orgId: '88888888-2222-4333-8444-555555555555' }, 'active'],
    ['a service user', { ...userRow, kind: 'service' }, 'active'],
    ['a suspended tenant', userRow, 'suspended'],
    ['a missing tenant', userRow, undefined],
  ])('4: %s -> null', async (_label, user, status) => {
    expect(await internalSession(db(user, status), ORG, USER)).toBeNull();
  });
});
