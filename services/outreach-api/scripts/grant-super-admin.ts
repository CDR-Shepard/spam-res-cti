import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import { flags } from './_cli.js';
const f = flags(['email', 'org-slug']);
const db = getDb();
const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.slug, f['org-slug']!) });
if (!org) { console.error('no such tenant'); process.exit(1); }
const rows = await db.update(schema.users).set({ isSuperAdmin: true, isAdmin: true })
  .where(and(eq(schema.users.orgId, org.id), eq(schema.users.email, f.email!.toLowerCase()), eq(schema.users.kind, 'human')))
  .returning({ id: schema.users.id });
console.log(rows.length ? `granted super admin to ${f.email} (${rows[0]!.id})` : `no human user ${f.email} in ${f['org-slug']}`);
process.exit(rows.length ? 0 : 1);
