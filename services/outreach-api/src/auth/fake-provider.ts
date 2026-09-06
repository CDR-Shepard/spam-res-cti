import type { RoleSlug } from '@cti/contracts';
import { IdentityExchangeError, type ExchangeResult, type IdentityInvite, type IdentityMembership, type IdentityProvider, type IdentityUser } from './identity-provider.js';

/** In-memory identity provider for tests and for local dev without WorkOS credentials. */
export class FakeIdentityProvider implements IdentityProvider {
  private users = new Map<string, { user: IdentityUser; memberships: IdentityMembership[] }>();
  private codes = new Map<string, { externalId: string; organizationId: string | null }>();
  private orgs = new Map<string, { id: string; name: string; externalId: string }>();
  /** Stores the full record, including provider-internal fields no `IdentityProvider` method returns (see `listInvites`); `lastInvite()` exposes it for tests. */
  private invites: Array<IdentityInvite & { organizationId: string; inviterExternalId?: string }> = [];
  private seq = 0;

  addUser(user: IdentityUser, orgs: Array<{ organizationId: string; role: string; status?: IdentityMembership['status'] }>): void {
    const normalized: IdentityUser = { ...user, email: user.email.trim().toLowerCase() };
    this.users.set(user.externalId, {
      user: normalized,
      memberships: orgs.map((o) => ({ organizationId: o.organizationId, role: o.role, status: o.status ?? 'active' })),
    });
  }
  setNextCode(code: string, externalId: string, organizationId: string | null = null): void {
    this.codes.set(code, { externalId, organizationId });
  }
  /** Seed a WorkOS organization directly (no `createOrganization` call), for tests of self-healing lookups. */
  seedOrganization(input: { id: string; name: string; externalId: string }): void {
    this.orgs.set(input.id, { ...input });
  }

  authorizationUrl(input: { state: string; organizationId?: string }): string {
    const u = new URL('http://fake-idp.test/authorize');
    u.searchParams.set('state', input.state);
    if (input.organizationId) u.searchParams.set('organization_id', input.organizationId);
    return u.toString();
  }
  async exchangeCode(code: string): Promise<ExchangeResult> {
    const c = this.codes.get(code);
    const u = c && this.users.get(c.externalId);
    if (!c || !u) throw new IdentityExchangeError();
    this.codes.delete(code);
    return { user: u.user, organizationId: c.organizationId };
  }
  async listMemberships(externalUserId: string): Promise<IdentityMembership[]> {
    return this.users.get(externalUserId)?.memberships ?? [];
  }
  async createOrganization(input: { name: string; externalId: string }): Promise<{ id: string }> {
    const id = `org_fake_${++this.seq}`;
    this.orgs.set(id, { id, ...input });
    return { id };
  }
  async findOrganizationByExternalId(externalId: string): Promise<{ id: string } | null> {
    for (const org of this.orgs.values()) if (org.externalId === externalId) return { id: org.id };
    return null;
  }
  async invite(input: { email: string; organizationId: string; role: RoleSlug; inviterExternalId?: string }): Promise<IdentityInvite> {
    const inv: IdentityInvite = { id: `inv_${++this.seq}`, email: input.email.trim().toLowerCase(), role: input.role, state: 'pending', expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() };
    this.invites.push({ ...inv, organizationId: input.organizationId, ...(input.inviterExternalId ? { inviterExternalId: input.inviterExternalId } : {}) });
    return inv;
  }
  async listInvites(organizationId: string): Promise<IdentityInvite[]> {
    return this.invites
      .filter((i) => i.organizationId === organizationId)
      .map(({ organizationId: _orgId, inviterExternalId: _inviterExternalId, ...rest }) => rest);
  }
  /** Test-only: the most recently created invite's full stored record — including the WorkOS org id and the inviter's external id — so a test can assert routes/team.ts wired the caller through (see routes/team.test.ts). */
  lastInvite(): (IdentityInvite & { organizationId: string; inviterExternalId?: string }) | undefined {
    return this.invites.at(-1);
  }
}
