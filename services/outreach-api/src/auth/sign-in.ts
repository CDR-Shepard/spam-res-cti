import { and, eq, inArray } from 'drizzle-orm';
import { humanUserByEmail } from '@cti/auth';
import { schema, type Db, type Organization } from '@cti/db';
import type { IdentityProvider, IdentityUser } from './identity-provider.js';

export type SignInOutcome =
  | { ok: true; userId: string; orgId: string }
  | { ok: false; reason: 'no_tenant' | 'tenant_suspended' };

export interface SignInDeps {
  db: Db;
  idp: IdentityProvider;
}

/**
 * Candidate WorkOS org ids in preference order: the one WorkOS scoped the
 * sign-in to, then active memberships — but only when that selected org is
 * itself backed by an active membership. WorkOS's `organizationId` on the
 * authentication response reflects org *selection* (e.g. from a login screen),
 * not membership status, so a pending/inactive membership must not smuggle an
 * org in through it.
 */
function candidateOrgIds(selected: string | null, memberships: Array<{ organizationId: string; status: string }>): string[] {
  const ids = memberships.filter((m) => m.status === 'active').map((m) => m.organizationId);
  return [...new Set([...(selected && ids.includes(selected) ? [selected] : []), ...ids])];
}

async function pickTenant(db: Db, candidates: string[]): Promise<Organization | null> {
  if (candidates.length === 0) return null;
  const orgs = await db.query.organizations.findMany({ where: inArray(schema.organizations.workosOrgId, candidates) });
  for (const id of candidates) {
    const hit = orgs.find((o) => o.workosOrgId === id);
    if (hit) return hit;
  }
  return null;
}

function displayName(u: IdentityUser): string | null {
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return name || null;
}

async function linkOrCreateUser(db: Db, org: Organization, u: IdentityUser, isAdminRole: boolean): Promise<string> {
  // Email normalization is a port invariant (see IdentityUser.email), but this
  // is the tenant boundary — normalize defensively rather than trust every
  // current and future IdentityProvider implementation to have done it.
  const email = u.email.trim().toLowerCase();
  const existing = await db.query.users.findFirst({ where: humanUserByEmail(org.id, email) });
  if (existing) {
    await db
      .update(schema.users)
      .set({ externalAuthId: u.externalId, isAdmin: existing.isAdmin || isAdminRole, displayName: existing.displayName ?? displayName(u) })
      .where(and(eq(schema.users.id, existing.id), eq(schema.users.orgId, org.id)));
    return existing.id;
  }
  const [created] = await db
    .insert(schema.users)
    .values({ orgId: org.id, email, displayName: displayName(u), kind: 'human', externalAuthId: u.externalId, isAdmin: isAdminRole, timezone: org.timezone })
    .returning({ id: schema.users.id });
  return created!.id;
}

/** Exchange the code, map the WorkOS organization to a tenant, and link or create the human user. */
export async function completeSignIn(deps: SignInDeps, code: string): Promise<SignInOutcome> {
  const { user, organizationId } = await deps.idp.exchangeCode(code);
  const memberships = await deps.idp.listMemberships(user.externalId);
  const org = await pickTenant(deps.db, candidateOrgIds(organizationId, memberships));
  if (!org) return { ok: false, reason: 'no_tenant' };
  if (org.status !== 'active') return { ok: false, reason: 'tenant_suspended' };
  const role = memberships.find((m) => m.status === 'active' && m.organizationId === org.workosOrgId)?.role;
  const userId = await linkOrCreateUser(deps.db, org, user, role === 'admin');
  return { ok: true, userId, orgId: org.id };
}
