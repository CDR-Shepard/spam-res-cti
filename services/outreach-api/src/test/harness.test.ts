import { describe, expect, it } from 'vitest';
import { eq, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema } from '@cti/db';
import { fakeDb } from './harness.js';

describe('fakeDb extensions', () => {
  it('serves any db.query table from `tables`, and an unlisted table as empty', async () => {
    const { db } = fakeDb({ tables: { campaigns: [{ id: 'C1' }] } });
    expect(await db.query.campaigns.findFirst()).toEqual({ id: 'C1' });
    expect(await db.query.crmConnections.findFirst()).toBeUndefined();
    expect(await db.query.crmConnections.findMany()).toEqual([]);
  });

  it('resolves select chains from `selectResults` in await order, then falls back to users', async () => {
    const { db, captured } = fakeDb({ users: [{ id: 'U1' }], selectResults: [[{ n: 1 }], [{ n: 2 }]] });
    const first = await db.select().from(schema.campaigns).innerJoin(schema.crmRecords, eq(schema.crmRecords.id, schema.campaigns.id)).where(eq(schema.campaigns.orgId, 'O1')).orderBy(schema.campaigns.id).limit(5);
    const second = await db.select().from(schema.campaigns).groupBy(schema.campaigns.status);
    const third = await db.select().from(schema.users);
    expect([first, second, third]).toEqual([[{ n: 1 }], [{ n: 2 }], [{ id: 'U1' }]]);
    expect(new PgDialect().sqlToQuery(captured.where[0] as SQL).sql).toBe('"campaigns"."org_id" = $1');
  });

  it('records deletes and upserts, and merges insertDefaults under returned insert rows', async () => {
    const { db, deletes, upserts, writes, captured } = fakeDb({ deleteReturning: [{ id: 'S1' }], insertDefaults: { createdAt: 'then', status: 'draft' } });
    expect(await db.delete(schema.crmOauthStates).where(eq(schema.crmOauthStates.state, 's')).returning()).toEqual([{ id: 'S1' }]);
    expect(deletes).toEqual([{ table: schema.crmOauthStates }]);
    expect(captured.where).toHaveLength(1);
    const [row] = await db.insert(schema.campaigns).values({ name: 'N', status: 'dry_run' } as never).returning();
    expect(row).toEqual({ id: 'new-1', createdAt: 'then', status: 'dry_run', name: 'N' });
    await db.insert(schema.crmConnections).values({ orgId: 'O1' } as never).onConflictDoUpdate({ target: [schema.crmConnections.orgId, schema.crmConnections.provider], set: { status: 'connected' } });
    expect(upserts).toEqual([{ table: schema.crmConnections, values: { orgId: 'O1' }, set: { status: 'connected' } }]);
    expect(writes.map((w) => w.op)).toEqual(['insert', 'insert']);
  });
});
