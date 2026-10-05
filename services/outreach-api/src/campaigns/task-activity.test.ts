import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import type { SalesforceClient } from '@cti/salesforce';
import { createTestDb, pgLane } from '../test/pg.js';
import { leadId, seedCampaign, seedEnrollment, seedOrg, seedRecord, snapshot } from '../test/outreach-fixtures.js';

/** An 18-character Lead Id whose 15-character core is unique (the last 3 characters are Salesforce's checksum). */
const sfId = (n: number): string => `00Q${String(n).padStart(12, '0')}AAA`;
import { flagRecordsWithNewTasks, taskActivitySoql, TASK_ACTIVITY_OVERLAP_MS } from './task-activity.js';

const SINCE = new Date('2026-10-05T11:00:00.123Z');
const CLAIMED = new Date('2026-10-05T14:00:00.000Z');

describe('taskActivitySoql', () => {
  it('asks for Tasks on any of the ids, as who or what, modified after the cutoff (whole seconds, UTC)', () => {
    expect(taskActivitySoql([leadId(1), leadId(2)], new Date('2026-10-05T10:55:00.123Z'))).toBe(
      `SELECT WhoId, WhatId FROM Task WHERE (WhoId IN ('${leadId(1)}','${leadId(2)}') OR WhatId IN ('${leadId(1)}','${leadId(2)}')) ` +
        'AND LastModifiedDate > 2026-10-05T10:55:00Z',
    );
  });

  it('drops anything that is not a Salesforce id before it reaches the SOQL text', () => {
    expect(taskActivitySoql([leadId(1), "x') OR Id != ('"], SINCE)).not.toContain('OR Id');
  });
});

describe.skipIf(!pgLane)('flagRecordsWithNewTasks (real Postgres, fake Salesforce)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  /** Tasks are returned for the given who/what ids, whatever the query's IN list. */
  function fakeSalesforce(tasks: Array<{ WhoId: string | null; WhatId: string | null }>) {
    const soql: string[] = [];
    const client = {
      queryAll: vi.fn(async (q: string) => {
        soql.push(q);
        return tasks.filter((t) => [t.WhoId, t.WhatId].some((id) => id !== null && q.includes(`'${id.slice(0, 15)}`)));
      }),
    } as unknown as SalesforceClient;
    return { client, soql };
  }

  async function campaignWith(n: number, status: 'active' | 'needs_review' | 'exited' = 'active') {
    const orgId = await seedOrg(db);
    const campaign = await seedCampaign(db, orgId, { status: 'dry_run' });
    const records: string[] = [];
    for (let i = 1; i <= n; i++) {
      const id = await seedRecord(db, orgId, snapshot({ sfRecordId: sfId(i) }), { triageNeeded: false, triageAttemptedAt: CLAIMED });
      await seedEnrollment(db, orgId, campaign.id, id, { status });
      records.push(id);
    }
    return { orgId, campaignId: campaign.id, records };
  }
  const record = async (id: string) => (await db.select().from(schema.crmRecords).where(eq(schema.crmRecords.id, id)))[0]!;

  it('marks a record with a Task logged since the last refresh as needing triage, and leaves the others', async () => {
    const c = await campaignWith(2);
    const sf = fakeSalesforce([{ WhoId: sfId(2), WhatId: null }]);
    expect(await flagRecordsWithNewTasks(db, sf.client, { campaignId: c.campaignId, since: SINCE })).toBe(1);
    expect(sf.soql).toEqual([taskActivitySoql([sfId(1), sfId(2)], new Date(SINCE.getTime() - TASK_ACTIVITY_OVERLAP_MS))]);
    expect(await record(c.records[1]!)).toMatchObject({ triageNeeded: true, triageAttemptedAt: null });
    expect(await record(c.records[0]!)).toMatchObject({ triageNeeded: false, triageAttemptedAt: CLAIMED });
  });

  it('matches a WhatId (Opportunity) and a 15-character id against the stored 18-character one', async () => {
    const c = await campaignWith(2);
    const sf = fakeSalesforce([{ WhoId: null, WhatId: sfId(1).slice(0, 15) }]);
    expect(await flagRecordsWithNewTasks(db, sf.client, { campaignId: c.campaignId, since: SINCE })).toBe(1);
    expect(await record(c.records[0]!)).toMatchObject({ triageNeeded: true });
  });

  it('queries 200 ids at a time', async () => {
    const c = await campaignWith(201);
    const sf = fakeSalesforce([{ WhoId: sfId(201), WhatId: null }]);
    expect(await flagRecordsWithNewTasks(db, sf.client, { campaignId: c.campaignId, since: SINCE })).toBe(1);
    expect(sf.soql).toHaveLength(2);
    expect(sf.soql[0]!.match(/'00Q/g)).toHaveLength(400);
    expect(sf.soql[1]!.match(/'00Q/g)).toHaveLength(2);
  });

  it('covers needs_review enrollments but not finished ones', async () => {
    const held = await campaignWith(1, 'needs_review');
    const sfHeld = fakeSalesforce([{ WhoId: sfId(1), WhatId: null }]);
    expect(await flagRecordsWithNewTasks(db, sfHeld.client, { campaignId: held.campaignId, since: SINCE })).toBe(1);
    const done = await campaignWith(1, 'exited');
    const sfDone = fakeSalesforce([{ WhoId: sfId(1), WhatId: null }]);
    expect(await flagRecordsWithNewTasks(db, sfDone.client, { campaignId: done.campaignId, since: SINCE })).toBe(0);
    expect(sfDone.soql).toEqual([]);
  });
});
