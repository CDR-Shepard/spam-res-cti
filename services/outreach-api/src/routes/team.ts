import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { humanUserById, humanUsersInOrg } from '@cti/auth';
import { InviteRequest, RoleSlug, UpdateTeamMemberRequest, type Invite, type InvitesResponse, type TeamMember } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import type { IdentityInvite, IdentityProvider } from '../auth/identity-provider.js';
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

/** Strips provider-internal fields (e.g. WorkOS's own org id) down to exactly the `Invite` contract's shape. */
function toInviteDto(i: IdentityInvite): Invite {
  const role = RoleSlug.safeParse(i.role);
  return { id: i.id, email: i.email, role: role.success ? role.data : null, state: i.state, expiresAt: i.expiresAt };
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
      .orderBy(schema.users.displayName, schema.users.email);
    return { members: rows.map(toMember) };
  });

  app.get('/team/invites', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    const linked = linkedOrgId(ctx, deps, reply);
    if (!linked) return;
    const invites = await linked.idp.listInvites(linked.workosOrgId);
    return { invites: invites.map(toInviteDto) } satisfies InvitesResponse;
  });

  app.post('/team/invites', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    // Validate the body before touching the WorkOS-link gates, so a malformed
    // request on an unlinked tenant is 400, not a misleading 409/503.
    const body = InviteRequest.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'VALIDATION', 'Invalid invite', body.error.flatten());
    const linked = linkedOrgId(ctx, deps, reply);
    if (!linked) return;
    const inviter = await db.query.users.findFirst({ where: eq(schema.users.id, ctx.session.userId), columns: { externalAuthId: true } });
    const invite = await linked.idp.invite({
      email: body.data.email,
      organizationId: linked.workosOrgId,
      role: body.data.role,
      ...(inviter?.externalAuthId ? { inviterExternalId: inviter.externalAuthId } : {}),
    });
    return reply.code(201).send(toInviteDto(invite));
  });

  app.patch('/team/:userId', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    // A malformed or non-uuid id can never match a row — 404 rather than 400,
    // same "don't let callers distinguish malformed from unknown" rule as
    // admin-tenants.ts's tenant-id param.
    const params = z.object({ userId: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'MEMBER_NOT_FOUND', 'No such team member');
    const body = UpdateTeamMemberRequest.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'VALIDATION', 'Invalid update', body.error.flatten());
    // Only a self-demotion is refused; an admin may idempotently re-confirm
    // their own admin flag (isAdmin: true) on themselves.
    if (params.data.userId === ctx.session.userId && !body.data.isAdmin) {
      return sendError(reply, 403, 'CANNOT_DEMOTE_SELF', 'You cannot remove your own admin access');
    }
    const [updated] = await db
      .update(schema.users)
      .set({ isAdmin: body.data.isAdmin })
      .where(humanUserById(ctx.orgId, params.data.userId))
      .returning({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName, isAdmin: schema.users.isAdmin, powerDialerEnabled: schema.users.powerDialerEnabled, externalAuthId: schema.users.externalAuthId });
    if (!updated) return sendError(reply, 404, 'MEMBER_NOT_FOUND', 'No such team member');
    return toMember(updated);
  });
}
