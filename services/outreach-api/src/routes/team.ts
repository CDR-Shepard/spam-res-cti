import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { humanUserById, humanUsersInOrg } from '@cti/auth';
import { InviteRequest, UpdateTeamMemberRequest, type TeamMember } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import type { IdentityProvider } from '../auth/identity-provider.js';
import { sendError } from '../http/errors.js';
import { requireAdmin, requireContext, type RequestContext } from '../tenancy/scope.js';

export interface TeamRouteDeps {
  db: Db;
  idp: IdentityProvider | null;
}

type UserRow = { id: string; email: string; displayName: string | null; isAdmin: boolean; powerDialerEnabled: boolean; externalAuthId: string | null };

function toMember(u: UserRow): TeamMember {
  return { id: u.id, email: u.email, displayName: u.displayName, isAdmin: u.isAdmin, powerDialerEnabled: u.powerDialerEnabled, signedIn: u.externalAuthId != null };
}

function linkedOrgId(ctx: RequestContext, deps: TeamRouteDeps, reply: FastifyReply): { idp: IdentityProvider; workosOrgId: string } | null {
  if (!deps.idp) {
    sendError(reply, 503, 'SIGN_IN_DISABLED', 'WorkOS is not configured on this server');
    return null;
  }
  if (!ctx.tenant.workosOrgId) {
    sendError(reply, 409, 'WORKOS_NOT_LINKED', 'This tenant is not linked to WorkOS yet');
    return null;
  }
  return { idp: deps.idp, workosOrgId: ctx.tenant.workosOrgId };
}

export async function registerTeamRoutes(app: FastifyInstance, deps: TeamRouteDeps): Promise<void> {
  const { db } = deps;

  app.get('/team', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx) return;
    const rows = await db
      .select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName, isAdmin: schema.users.isAdmin, powerDialerEnabled: schema.users.powerDialerEnabled, externalAuthId: schema.users.externalAuthId })
      .from(schema.users)
      .where(humanUsersInOrg(ctx.orgId))
      .orderBy(schema.users.email);
    return { members: rows.map(toMember) };
  });

  app.get('/team/invites', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    const linked = linkedOrgId(ctx, deps, reply);
    if (!linked) return;
    return { invites: await linked.idp.listInvites(linked.workosOrgId) };
  });

  app.post('/team/invites', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    const linked = linkedOrgId(ctx, deps, reply);
    if (!linked) return;
    const body = InviteRequest.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'VALIDATION', 'Invalid invite', body.error.flatten());
    const inviter = await db.query.users.findFirst({ where: eq(schema.users.id, ctx.session.userId), columns: { externalAuthId: true } });
    const invite = await linked.idp.invite({
      email: body.data.email,
      organizationId: linked.workosOrgId,
      role: body.data.role,
      ...(inviter?.externalAuthId ? { inviterExternalId: inviter.externalAuthId } : {}),
    });
    return reply.code(201).send(invite);
  });

  app.patch('/team/:userId', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    const params = z.object({ userId: z.string().min(1) }).safeParse(req.params);
    const body = UpdateTeamMemberRequest.safeParse(req.body);
    if (!params.success || !body.success) return sendError(reply, 400, 'VALIDATION', 'Invalid update');
    if (params.data.userId === ctx.session.userId) return sendError(reply, 400, 'CANNOT_CHANGE_SELF', 'You cannot change your own admin flag');
    const [updated] = await db
      .update(schema.users)
      .set({ isAdmin: body.data.isAdmin })
      .where(humanUserById(ctx.orgId, params.data.userId))
      .returning({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName, isAdmin: schema.users.isAdmin, powerDialerEnabled: schema.users.powerDialerEnabled, externalAuthId: schema.users.externalAuthId });
    if (!updated) return sendError(reply, 404, 'NOT_FOUND', 'No such team member');
    return toMember(updated);
  });
}
