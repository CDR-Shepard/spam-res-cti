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

/** Candidate WorkOS org ids in preference order: the one WorkOS scoped the sign-in to, then active memberships. */
function candidateOrgIds(selected: string | null, memberships: Array<{ organizationId: string; status: string }>): string[] {
  const ids = memberships.filter((m) => m.status === 'active').map((m) => m.organizationId);
  return [...new Set([...(selected ? [selected] : []), ...ids])];
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
  const existing = await db.query.users.findFirst({ where: humanUserByEmail(org.id, u.email) });
  if (existing) {
    await db
      .update(schema.users)
      .set({ externalAuthId: u.externalId, isAdmin: existing.isAdmin || isAdminRole, displayName: existing.displayName ?? displayName(u) })
      .where(and(eq(schema.users.id, existing.id), eq(schema.users.orgId, org.id)));
    return existing.id;
  }
  const [created] = await db
    .insert(schema.users)
    .values({ orgId: org.id, email: u.email, displayName: displayName(u), kind: 'human', externalAuthId: u.externalId, isAdmin: isAdminRole, timezone: org.timezone })
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
  const role = memberships.find((m) => m.organizationId === org.workosOrgId)?.role;
  const userId = await linkOrCreateUser(deps.db, org, user, role === 'admin');
  return { ok: true, userId, orgId: org.id };
}
