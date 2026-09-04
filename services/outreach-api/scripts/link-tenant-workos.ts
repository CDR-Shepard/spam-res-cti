import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { LinkTenantWorkosRequest } from '@cti/contracts';
import { schema } from '@cti/db';
import { linkTenantToWorkos } from '../src/tenancy/provision.js';
import { deps, flags } from './_cli.js';
const f = flags(['org-slug', 'admin-email']);
const { adminEmail } = LinkTenantWorkosRequest.parse({ adminEmail: f['admin-email'] });
const d = deps();
const org = await d.db.query.organizations.findFirst({ where: eq(schema.organizations.slug, f['org-slug']!) });
if (!org) { console.error(`no tenant with slug ${f['org-slug']}`); process.exit(1); }
const orgId = z.string().uuid().parse(org.id);
const out = await linkTenantToWorkos(d, orgId, adminEmail);
console.log(JSON.stringify({ tenantId: out.tenant.id, workosOrgId: out.tenant.workosOrgId, inviteId: out.inviteId }, null, 2));
process.exit(0);
