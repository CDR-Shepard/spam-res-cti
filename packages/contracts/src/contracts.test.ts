import { describe, expect, it } from 'vitest';
import {
  ApiError,
  InviteRequest,
  ProvisionTenantRequest,
  ROLE_SLUGS,
  SessionResponse,
  SessionUser,
  TeamResponse,
  UpdateTeamMemberRequest,
} from './index.js';

describe('contracts', () => {
  it('exposes the two WorkOS role slugs', () => {
    expect(ROLE_SLUGS).toEqual(['admin', 'member']);
  });

  const validUser = { userId: 'U1', orgId: 'O1', email: 'a@b.co', isAdmin: false, isSuperAdmin: false, kind: 'human', displayName: null };
  const validSession = {
    token: 't',
    expiresAt: '2026-10-01T00:00:00.000Z',
    user: validUser,
    tenant: { id: 'O1', name: 'GG Homes', slug: 'gg-homes', timezone: 'America/Los_Angeles', status: 'active' },
  };

  it('parses a session response', () => {
    expect(SessionResponse.safeParse(validSession).success).toBe(true);
  });

  it('rejects a non-human session user on exactly the kind field (the fixture differs from a valid one only there)', () => {
    const user = SessionUser.safeParse({ ...validUser, kind: 'robot' });
    expect(user.success).toBe(false);
    expect(user.success ? [] : user.error.issues.map((i) => i.path)).toEqual([['kind']]);
    const nested = SessionResponse.safeParse({ ...validSession, user: { ...validUser, kind: 'service' } });
    expect(nested.success).toBe(false);
    expect(nested.success ? [] : nested.error.issues.map((i) => i.path)).toEqual([['user', 'kind']]);
  });

  it('validates invite requests: lowercases email, defaults role to member', () => {
    expect(InviteRequest.parse({ email: 'Rep@Example.com' })).toEqual({ email: 'rep@example.com', role: 'member' });
    expect(InviteRequest.safeParse({ email: 'not-an-email' }).success).toBe(false);
    expect(InviteRequest.safeParse({ email: 'a@b.co', role: 'owner' }).success).toBe(false);
  });

  it('validates team member updates and provisioning requests', () => {
    expect(UpdateTeamMemberRequest.parse({ isAdmin: true })).toEqual({ isAdmin: true });
    expect(UpdateTeamMemberRequest.safeParse({}).success).toBe(false);
    const p = ProvisionTenantRequest.parse({ name: 'Acme Buyers', adminEmail: 'OWNER@acme.com' });
    expect(p).toEqual({ name: 'Acme Buyers', adminEmail: 'owner@acme.com', timezone: 'America/Los_Angeles' });
    expect(ProvisionTenantRequest.safeParse({ name: '', adminEmail: 'x@y.z' }).success).toBe(false);
    expect(ProvisionTenantRequest.safeParse({ name: 'A', slug: 'Bad Slug', adminEmail: 'x@y.z' }).success).toBe(false);
  });

  it('parses the error envelope and a team response', () => {
    expect(ApiError.parse({ error: 'Forbidden', code: 'FORBIDDEN', requestId: 'req-1' }).code).toBe('FORBIDDEN');
    const team = TeamResponse.parse({
      members: [{ id: 'U1', email: 'a@b.co', displayName: 'A', isAdmin: true, powerDialerEnabled: false, signedIn: true }],
    });
    expect(team.members).toHaveLength(1);
  });
});
