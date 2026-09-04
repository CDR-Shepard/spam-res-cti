import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LinkTenantWorkosRequest, ProvisionTenantRequest } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import type { IdentityProvider } from '../auth/identity-provider.js';
import { sendError } from '../http/errors.js';
import { linkTenantToWorkos, provisionTenant } from '../tenancy/provision.js';
import { requireContext, toTenantDto } from '../tenancy/scope.js';

export interface AdminTenantDeps {
  db: Db;
  idp: IdentityProvider | null;
}

export async function registerAdminTenantRoutes(app: FastifyInstance, deps: AdminTenantDeps): Promise<void> {
  const { db } = deps;
  const superAdminOnly = async (req: Parameters<typeof requireContext>[1], reply: Parameters<typeof requireContext>[2]) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx) return null;
    if (!ctx.session.isSuperAdmin) {
      sendError(reply, 403, 'SUPER_ADMIN_ONLY', 'Platform staff only');
      return null;
    }
    return ctx;
  };
  const idpOr503 = (reply: Parameters<typeof requireContext>[2]) => {
    if (!deps.idp) sendError(reply, 503, 'SIGN_IN_DISABLED', 'WorkOS is not configured on this server');
    return deps.idp;
  };

  app.get('/admin/tenants', async (req, reply) => {
    if (!(await superAdminOnly(req, reply))) return;
    const rows = await db.query.organizations.findMany({ limit: 200, orderBy: schema.organizations.createdAt });
    return { tenants: rows.map(toTenantDto) };
  });

  app.post('/admin/tenants', async (req, reply) => {
    if (!(await superAdminOnly(req, reply))) return;
    const idp = idpOr503(reply);
    if (!idp) return;
    const body = ProvisionTenantRequest.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'VALIDATION', 'Invalid tenant request', body.error.flatten());
    const out = await provisionTenant({ db, idp, log: req.log }, body.data);
    return reply.code(201).send({ tenant: toTenantDto(out.tenant), inviteId: out.inviteId });
  });

  app.post('/admin/tenants/:id/link-workos', async (req, reply) => {
    if (!(await superAdminOnly(req, reply))) return;
    const idp = idpOr503(reply);
    if (!idp) return;
    // A non-uuid id can never match a tenant, so it's a 404 (same as a
    // well-formed id that just isn't found below) rather than a 400 —
    // callers shouldn't be able to distinguish "malformed" from "unknown".
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'TENANT_NOT_FOUND', 'Unknown tenant');
    const body = LinkTenantWorkosRequest.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'VALIDATION', 'Invalid link request');
    try {
      const out = await linkTenantToWorkos({ db, idp, log: req.log }, params.data.id, body.data.adminEmail);
      return { tenant: toTenantDto(out.tenant), inviteId: out.inviteId };
    } catch (err) {
      if ((err as Error).message.startsWith('Unknown tenant')) return sendError(reply, 404, 'TENANT_NOT_FOUND', 'Unknown tenant');
      throw err;
    }
  });
}
