/**
 * Tenant provisioning shared by the Salesforce login path (cti-api) and the
 * product's provisionTenant (outreach-api, later plan): one org, its AI Agent
 * service user, and the default campaign, in a single transaction.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema, type Db, type Organization } from '@cti/db';

export const AI_AGENT_DISPLAY_NAME = 'AI Agent';
const DEFAULT_TIMEZONE = 'America/Los_Angeles';

export function aiAgentEmail(slug: string): string {
  return `ai-agent@${slug}.internal`;
}

/** Lowercase; runs of non-alphanumerics become one '-'; leading/trailing dashes trimmed. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export interface CreateTenantInput {
  name: string;
  slug?: string;
  timezone?: string;
  sfOrgId?: string | null;
}

export interface CreatedTenant {
  org: Organization;
  aiAgentUserId: string;
}

export async function createTenant(db: Db, input: CreateTenantInput): Promise<CreatedTenant> {
  const base = slugify(input.slug ?? input.name) || 'org';
  const timezone = input.timezone ?? DEFAULT_TIMEZONE;
  return db.transaction(async (tx) => {
    const taken = await tx.query.organizations.findFirst({
      where: eq(schema.organizations.slug, base),
      columns: { id: true },
    });
    const slug = taken ? `${base}-${randomBytes(3).toString('hex')}` : base;
    const [org] = await tx
      .insert(schema.organizations)
      .values({ name: input.name, slug, timezone, sfOrgId: input.sfOrgId ?? null })
      .returning();
    const [agent] = await tx
      .insert(schema.users)
      .values({ orgId: org!.id, email: aiAgentEmail(slug), displayName: AI_AGENT_DISPLAY_NAME, kind: 'service', timezone })
      .returning({ id: schema.users.id });
    await tx
      .insert(schema.campaignConfigs)
      .values({ orgId: org!.id, key: 'default', name: 'Default Campaign' })
      .onConflictDoNothing();
    return { org: org!, aiAgentUserId: agent!.id };
  });
}
