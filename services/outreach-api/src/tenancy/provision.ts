import { eq } from 'drizzle-orm';
import { createTenant } from '@cti/auth';
import type { ProvisionTenantRequest } from '@cti/contracts';
import { schema, type Db, type Organization } from '@cti/db';
import { dispatchAlert } from '../alerts.js';
import type { IdentityProvider } from '../auth/identity-provider.js';

export interface ProvisionDeps {
  db: Db;
  idp: IdentityProvider;
  log: { error: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; info: (o: unknown, m?: string) => void };
}
export interface ProvisionResult {
  tenant: Organization;
  inviteId: string;
}

async function ensureWorkosOrg(deps: ProvisionDeps, tenant: Organization): Promise<Organization> {
  if (tenant.workosOrgId) return tenant;
  const created = await deps.idp.createOrganization({ name: tenant.name, externalId: tenant.id });
  await deps.db.update(schema.organizations).set({ workosOrgId: created.id }).where(eq(schema.organizations.id, tenant.id));
  return { ...tenant, workosOrgId: created.id };
}

async function inviteAdmin(deps: ProvisionDeps, tenant: Organization, adminEmail: string): Promise<string> {
  const invite = await deps.idp.invite({ email: adminEmail, organizationId: tenant.workosOrgId!, role: 'admin' });
  deps.log.info({ orgId: tenant.id, inviteId: invite.id }, 'tenant admin invited');
  return invite.id;
}

/** New tenant: our org + AI Agent + default campaign (createTenant), then the WorkOS org and the admin invite. */
export async function provisionTenant(deps: ProvisionDeps, input: ProvisionTenantRequest): Promise<ProvisionResult> {
  const { org } = await createTenant(deps.db, { name: input.name, slug: input.slug, timezone: input.timezone });
  try {
    const tenant = await ensureWorkosOrg(deps, org);
    const inviteId = await inviteAdmin(deps, tenant, input.adminEmail);
    return { tenant, inviteId };
  } catch (err) {
    await dispatchAlert(deps.log, {
      kind: 'provisioning_failed',
      severity: 'warning',
      orgId: org.id,
      message: `Tenant ${org.slug} created but WorkOS link/invite failed: ${(err as Error).message}. Repair with link-tenant-workos.`,
      context: { adminEmail: input.adminEmail },
    });
    throw err;
  }
}

/** Existing tenant (e.g. one created by Salesforce login): create/reuse the WorkOS org and invite an admin. */
export async function linkTenantToWorkos(deps: ProvisionDeps, orgId: string, adminEmail: string): Promise<ProvisionResult> {
  const found = await deps.db.query.organizations.findFirst({ where: eq(schema.organizations.id, orgId) });
  if (!found || found.id !== orgId) throw new Error(`Unknown tenant ${orgId}`);
  const tenant = await ensureWorkosOrg(deps, found);
  const inviteId = await inviteAdmin(deps, tenant, adminEmail);
  return { tenant, inviteId };
}
