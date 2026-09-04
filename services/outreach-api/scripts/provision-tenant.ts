import { ProvisionTenantRequest } from '@cti/contracts';
import { provisionTenant } from '../src/tenancy/provision.js';
import { deps, flags } from './_cli.js';
const f = flags(['name', 'admin-email']);
const input = ProvisionTenantRequest.parse({ name: f.name, slug: f.slug, timezone: f.timezone, adminEmail: f['admin-email'] });
const out = await provisionTenant(deps(), input);
console.log(JSON.stringify({ tenantId: out.tenant.id, slug: out.tenant.slug, workosOrgId: out.tenant.workosOrgId, inviteId: out.inviteId }, null, 2));
process.exit(0);
