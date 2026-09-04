import { WorkOS } from '@workos-inc/node';
import type { RoleSlug } from '@cti/contracts';
import { IdentityExchangeError, type ExchangeResult, type IdentityInvite, type IdentityMembership, type IdentityProvider } from './identity-provider.js';

export interface WorkosSettings {
  apiKey: string;
  clientId: string;
  redirectUri: string;
}

interface WorkosInvitation {
  id: string;
  email: string;
  state: 'pending' | 'accepted' | 'expired' | 'revoked';
  expiresAt: string;
  roleSlug: string | null;
}

function toInvite(i: WorkosInvitation): IdentityInvite {
  return { id: i.id, email: i.email.toLowerCase(), role: i.roleSlug, state: i.state, expiresAt: i.expiresAt };
}

/**
 * Statuses that mean the sign-in CODE itself was bad (invalid, expired, already
 * used, or the user/organization it names doesn't exist) — never a server fault,
 * so these map to `IdentityExchangeError`. Everything else (403/408/409/429,
 * 5xx, or no numeric status at all) propagates as-is: those are auth/rate-limit/
 * conflict/server conditions the caller should treat as an operational error,
 * not "please try signing in again."
 */
const IDENTITY_EXCHANGE_STATUSES = new Set([400, 401, 404]);

export function isClientError(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  return typeof status === 'number' && IDENTITY_EXCHANGE_STATUSES.has(status);
}

export class WorkosIdentityProvider implements IdentityProvider {
  private readonly workos: WorkOS;
  constructor(private readonly settings: WorkosSettings) {
    this.workos = new WorkOS({ apiKey: settings.apiKey, clientId: settings.clientId });
  }

  authorizationUrl(input: { state: string; organizationId?: string }): string {
    return this.workos.userManagement.getAuthorizationUrl({
      provider: 'authkit',
      clientId: this.settings.clientId,
      redirectUri: this.settings.redirectUri,
      state: input.state,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    });
  }

  async exchangeCode(code: string): Promise<ExchangeResult> {
    try {
      const r = await this.workos.userManagement.authenticateWithCode({ clientId: this.settings.clientId, code });
      return {
        user: { externalId: r.user.id, email: r.user.email.toLowerCase(), firstName: r.user.firstName, lastName: r.user.lastName },
        organizationId: r.organizationId ?? null,
      };
    } catch (err) {
      if (isClientError(err)) throw new IdentityExchangeError();
      throw err;
    }
  }

  async listMemberships(externalUserId: string): Promise<IdentityMembership[]> {
    const page = await this.workos.userManagement.listOrganizationMemberships({ userId: externalUserId, statuses: ['active'], limit: 100 });
    return page.data.map((m) => ({ organizationId: m.organizationId, role: m.role.slug, status: m.status }));
  }

  async createOrganization(input: { name: string; externalId: string }): Promise<{ id: string }> {
    const org = await this.workos.organizations.createOrganization({ name: input.name, externalId: input.externalId });
    return { id: org.id };
  }

  async findOrganizationByExternalId(externalId: string): Promise<{ id: string } | null> {
    try {
      const org = await this.workos.organizations.getOrganizationByExternalId(externalId);
      return { id: org.id };
    } catch (err) {
      if ((err as { status?: unknown })?.status === 404) return null;
      throw err;
    }
  }

  async invite(input: { email: string; organizationId: string; role: RoleSlug; inviterExternalId?: string }): Promise<IdentityInvite> {
    const inv = await this.workos.userManagement.sendInvitation({
      email: input.email,
      organizationId: input.organizationId,
      roleSlug: input.role,
      expiresInDays: 7,
      ...(input.inviterExternalId ? { inviterUserId: input.inviterExternalId } : {}),
    });
    return toInvite(inv);
  }

  async listInvites(organizationId: string): Promise<IdentityInvite[]> {
    const page = await this.workos.userManagement.listInvitations({ organizationId, limit: 100 });
    return page.data.map(toInvite);
  }
}
