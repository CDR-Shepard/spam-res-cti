/**
 * The two ways cti-api looks up people, both tenant-scoped and both excluding
 * kind='service' (the AI Agent must never appear in rosters, assignment
 * dropdowns, or a login match).
 */
import { and, eq, type SQL } from 'drizzle-orm';
import { schema } from '@cti/db';

export function humanUsersInOrg(orgId: string): SQL {
  return and(eq(schema.users.orgId, orgId), eq(schema.users.kind, 'human'))!;
}

export function humanUserByEmail(orgId: string, email: string): SQL {
  return and(eq(schema.users.orgId, orgId), eq(schema.users.email, email), eq(schema.users.kind, 'human'))!;
}
