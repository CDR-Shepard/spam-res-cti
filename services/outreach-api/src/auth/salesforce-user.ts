/**
 * Map a Salesforce identity to the CTI user it already is. outreach never creates a tenant
 * or a user from a sign-in, and never changes is_admin: the CTI owns both (cti-api's own
 * Salesforce login creates and re-syncs them).
 */
import { and, eq, sql } from 'drizzle-orm';
import { humanUserByEmail } from '@cti/auth';
import { schema, type Db } from '@cti/db';
import type { SalesforceIdentity } from './salesforce-identity.js';

const CORE = 15;
export type SalesforceUserMatch = { ok: true; userId: string; orgId: string } | { ok: false; reason: 'no_tenant' | 'tenant_suspended' | 'no_account' };

/** cti-api's fallback address for a Salesforce user whose profile has no email. */
export const syntheticSalesforceEmail = (id: Pick<SalesforceIdentity, 'sfOrgId' | 'sfUserId'>): string => `sf-${id.sfUserId}@${id.sfOrgId}.salesforce.local`.toLowerCase();

export async function matchSalesforceUser(db: Db, id: SalesforceIdentity): Promise<SalesforceUserMatch> {
  const orgCore = id.sfOrgId.slice(0, CORE);
  const [org] = await db
    .select({ id: schema.organizations.id, status: schema.organizations.status })
    .from(schema.organizations)
    .where(sql`left(${schema.organizations.sfOrgId}, ${CORE}) = ${orgCore}`)
    .limit(1);
  if (!org) return { ok: false, reason: 'no_tenant' };
  if (org.status !== 'active') return { ok: false, reason: 'tenant_suspended' };

  const [connected] = await db
    .select({ userId: schema.users.id })
    .from(schema.salesforceConnections)
    .innerJoin(schema.users, eq(schema.users.id, schema.salesforceConnections.userId))
    .where(and(
      eq(schema.users.orgId, org.id),
      eq(schema.users.kind, 'human'),
      sql`left(${schema.salesforceConnections.sfUserId}, ${CORE}) = ${id.sfUserId.slice(0, CORE)}`,
      sql`left(${schema.salesforceConnections.sfOrgId}, ${CORE}) = ${orgCore}`,
    ))
    .limit(1);
  if (connected) return { ok: true, userId: connected.userId, orgId: org.id };

  const email = (id.email ?? syntheticSalesforceEmail(id)).trim().toLowerCase();
  const user = await db.query.users.findFirst({ where: humanUserByEmail(org.id, email), columns: { id: true } });
  return user ? { ok: true, userId: user.id, orgId: org.id } : { ok: false, reason: 'no_account' };
}
