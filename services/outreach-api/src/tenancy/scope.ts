import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { resolveSession, type SessionUser } from '@cti/auth';
import type { Tenant } from '@cti/contracts';
import { schema, type Db, type Organization } from '@cti/db';
import { sendError } from '../http/errors.js';

export interface RequestContext {
  session: SessionUser;
  /** The tenant this request acts on: the session's own, or a super admin's X-Org-Id choice. */
  orgId: string;
  tenant: Organization;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function toTenantDto(org: Organization): Tenant {
  return { id: org.id, name: org.name, slug: org.slug, timezone: org.timezone, status: org.status as Tenant['status'], workosLinked: Boolean(org.workosOrgId) };
}

function requestedOrgId(session: SessionUser, req: FastifyRequest): string | null {
  const header = req.headers['x-org-id'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!session.isSuperAdmin || !value) return session.orgId;
  return UUID.test(value) ? value : null;
}

/** Resolve session + tenant or send the matching error. Fail closed on every branch. */
export async function requireContext(db: Db, req: FastifyRequest, reply: FastifyReply): Promise<RequestContext | null> {
  const session = await resolveSession(req.headers.authorization);
  if (!session) {
    sendError(reply, 401, 'UNAUTHENTICATED', 'Sign in required');
    return null;
  }
  const orgId = requestedOrgId(session, req);
  if (!orgId) {
    sendError(reply, 403, 'TENANT_FORBIDDEN', 'Invalid tenant selection');
    return null;
  }
  const tenant = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, orgId) });
  if (!tenant || tenant.id !== orgId) {
    sendError(reply, 403, 'TENANT_FORBIDDEN', 'Unknown tenant');
    return null;
  }
  if (tenant.status !== 'active') {
    sendError(reply, 403, 'TENANT_SUSPENDED', 'This tenant is suspended');
    return null;
  }
  return { session, orgId, tenant };
}

export function requireAdmin(ctx: RequestContext, reply: FastifyReply): boolean {
  if (ctx.session.isAdmin || ctx.session.isSuperAdmin) return true;
  sendError(reply, 403, 'ADMIN_ONLY', 'Admin access required');
  return false;
}
