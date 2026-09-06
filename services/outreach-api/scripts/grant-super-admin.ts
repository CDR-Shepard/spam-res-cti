import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import { closeDb, emit, fail, flags } from './_cli.js';
const f = flags(['email', 'org-slug']);
const db = getDb();
const org = (await db.query.organizations.findFirst({ where: eq(schema.organizations.slug, f['org-slug']!) })) ?? await fail('no such tenant');
const rows = await db.update(schema.users).set({ isSuperAdmin: true, isAdmin: true })
  .where(and(eq(schema.users.orgId, org.id), eq(schema.users.email, f.email!.toLowerCase()), eq(schema.users.kind, 'human')))
  .returning({ id: schema.users.id });
const granted = rows[0] ?? await fail(`no human user ${f.email} in ${f['org-slug']}`);
await emit(`granted super admin to ${f.email} (${granted.id})`);
await closeDb();
