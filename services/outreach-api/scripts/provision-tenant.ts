import { provisionTenant } from '../src/tenancy/provision.js';
import { deps, flags } from './_cli.js';
const f = flags(['name', 'admin-email']);
const out = await provisionTenant(deps(), { name: f.name!, slug: f.slug, timezone: f.timezone ?? 'America/Los_Angeles', adminEmail: f['admin-email']!.toLowerCase() });
console.log(JSON.stringify({ tenantId: out.tenant.id, slug: out.tenant.slug, workosOrgId: out.tenant.workosOrgId, inviteId: out.inviteId }, null, 2));
process.exit(0);
