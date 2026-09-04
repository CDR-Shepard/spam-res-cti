/**
 * The three ways cti-api looks up people, all tenant-scoped and all excluding
 * kind='service' (the AI Agent must never appear in rosters, assignment
 * dropdowns, a login match, or an admin's DID/power-dialer target).
 */
import { and, eq, type SQL } from 'drizzle-orm';
import { schema } from '@cti/db';

export function humanUsersInOrg(orgId: string): SQL {
  return and(eq(schema.users.orgId, orgId), eq(schema.users.kind, 'human'))!;
}

export function humanUserByEmail(orgId: string, email: string): SQL {
  return and(eq(schema.users.orgId, orgId), eq(schema.users.email, email), eq(schema.users.kind, 'human'))!;
}

export function humanUserById(orgId: string, userId: string): SQL {
  return and(eq(schema.users.id, userId), eq(schema.users.orgId, orgId), eq(schema.users.kind, 'human'))!;
}
