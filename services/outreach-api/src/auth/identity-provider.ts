import type { RoleSlug } from '@cti/contracts';

export interface IdentityUser {
  externalId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}
export interface IdentityMembership {
  organizationId: string;
  role: string;
  status: 'active' | 'inactive' | 'pending';
}
export interface IdentityInvite {
  id: string;
  email: string;
  role: string | null;
  state: 'pending' | 'accepted' | 'expired' | 'revoked';
  expiresAt: string;
}
export interface ExchangeResult {
  user: IdentityUser;
  /** The organization the provider scoped this sign-in to, when it did. */
  organizationId: string | null;
}

/** Everything the product needs from the hosted identity provider. Implemented by WorkOS and by a fake. */
export interface IdentityProvider {
  authorizationUrl(input: { state: string; organizationId?: string }): string;
  exchangeCode(code: string): Promise<ExchangeResult>;
  listMemberships(externalUserId: string): Promise<IdentityMembership[]>;
  createOrganization(input: { name: string; externalId: string }): Promise<{ id: string }>;
  invite(input: { email: string; organizationId: string; role: RoleSlug; inviterExternalId?: string }): Promise<IdentityInvite>;
  listInvites(organizationId: string): Promise<IdentityInvite[]>;
}

/** The authorization code was invalid, expired, or already used. Never a server fault. */
export class IdentityExchangeError extends Error {
  constructor(message = 'Sign-in code was rejected by the identity provider') {
    super(message);
    this.name = 'IdentityExchangeError';
  }
}
