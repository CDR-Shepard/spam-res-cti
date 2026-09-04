import { describe, expect, it } from 'vitest';
import { schema, type Db } from '@cti/db';
import { AI_AGENT_DISPLAY_NAME, aiAgentEmail, createTenant, slugify } from './tenancy.js';

describe('slugify', () => {
  it('lowercases and collapses non-alphanumerics to single dashes', () => {
    expect(slugify('GG Homes')).toBe('gg-homes');
    expect(slugify('Salesforce Org 00Dxx0000001234')).toBe('salesforce-org-00dxx0000001234');
    expect(slugify('  A -- B!! ')).toBe('a-b');
  });
  it('returns an empty string when nothing survives', () => {
    expect(slugify('---')).toBe('');
  });
});

function fakeDb(opts: { slugTaken?: boolean } = {}) {
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const tx = {
    query: { organizations: { findFirst: async () => (opts.slugTaken ? { id: 'existing' } : undefined) } },
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        const row = { id: `id-${inserts.length}`, ...values };
        return { returning: async () => [row], onConflictDoNothing: async () => undefined };
      },
    }),
  };
  const db = { ...tx, transaction: async <T,>(fn: (t: typeof tx) => Promise<T>) => fn(tx) };
  return { db: db as unknown as Db, inserts };
}

describe('createTenant', () => {
  it('creates the org, its AI Agent service user, and the default campaign in one transaction', async () => {
    const { db, inserts } = fakeDb();
    const out = await createTenant(db, { name: 'GG Homes', sfOrgId: '00Dxx0000001234' });
    expect(inserts.map((i) => i.table)).toEqual([schema.organizations, schema.users, schema.campaignConfigs]);
    expect(inserts[0]!.values).toMatchObject({ name: 'GG Homes', slug: 'gg-homes', timezone: 'America/Los_Angeles', sfOrgId: '00Dxx0000001234' });
    expect(inserts[1]!.values).toMatchObject({ orgId: 'id-1', kind: 'service', displayName: AI_AGENT_DISPLAY_NAME, email: 'ai-agent@gg-homes.internal', timezone: 'America/Los_Angeles' });
    expect(inserts[2]!.values).toMatchObject({ orgId: 'id-1', key: 'default', name: 'Default Campaign' });
    expect(out.org.slug).toBe('gg-homes');
    expect(out.aiAgentUserId).toBe('id-2');
  });

  it('honors an explicit slug and timezone', async () => {
    const { db, inserts } = fakeDb();
    await createTenant(db, { name: 'Whatever', slug: 'Custom Slug', timezone: 'America/Chicago' });
    expect(inserts[0]!.values).toMatchObject({ slug: 'custom-slug', timezone: 'America/Chicago' });
  });

  it('appends a random suffix when the slug is taken, and the agent email follows', async () => {
    const { db, inserts } = fakeDb({ slugTaken: true });
    const out = await createTenant(db, { name: 'GG Homes' });
    expect(out.org.slug).toMatch(/^gg-homes-[0-9a-f]{6}$/);
    expect(inserts[1]!.values.email).toBe(aiAgentEmail(out.org.slug));
  });

  it("falls back to 'org' when the name yields no slug", async () => {
    const { db, inserts } = fakeDb();
    await createTenant(db, { name: '!!!' });
    expect(inserts[0]!.values.slug).toBe('org');
  });
});
