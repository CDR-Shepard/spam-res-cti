/** The lead picker's enrollment view against real enrollments: which statuses hold a lead, which free it. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@cti/db';
import type { SalesforceClient } from '@cti/salesforce';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { seedCampaign, seedEnrollment, seedOrg, seedRecord, snapshot, TEST_FIELD_MAP } from '../test/outreach-fixtures.js';
import { candidatePage } from './candidates.js';
import { MemberIdCache } from './member-cache.js';

/** Ids differ inside their first 15 characters: Salesforce Ids of one record share those, and the fetch keys on them. */
const leadId = (n: number) => `00Q${String(n).padStart(12, '0')}AAA`;
const MEMBERSHIP = 'SELECT Id FROM Lead';
const row = (n: number) => ({ Id: leadId(n), Name: `Lead ${n}`, OwnerId: '005000000000001AAA', Owner: { Name: 'Rep One' }, LastModifiedDate: '2026-10-03T14:05:00.000+0000', IsConverted: false, MobilePhone: `+1512555${3000 + n}` });
const clientFor = (members: number[]) =>
  ({
    queryAll: vi.fn(async (q: string) => (q === MEMBERSHIP ? members.map((n) => ({ Id: leadId(n) })) : members.map(row))),
  }) as unknown as SalesforceClient;

describe.skipIf(!pgLane)('candidatePage enrollment states (real Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 120_000);
  afterAll(async () => { await t?.drop(); });

  it('reports each enrollment status; an exit that is not "deselected" holds the lead, a deselected one frees it', async () => {
    const orgId = await seedOrg(t.db);
    const c = await seedCampaign(t.db, orgId, { mode: 'ai_call', sourceKind: 'soql', listViewId: null, soql: MEMBERSHIP });
    const states: Array<[number, Partial<typeof schema.campaignEnrollments.$inferInsert>]> = [
      [1, { status: 'active', callStage: 'research' }],
      [2, { status: 'needs_review' }],
      [3, { status: 'exited', exitReason: 'deselected' }],
      [4, { status: 'exited', exitReason: 'left_query' }],
      [5, { status: 'handed_off' }],
    ];
    for (const [n, over] of states) {
      const recordId = await seedRecord(t.db, orgId, snapshot({ sfRecordId: leadId(n) }));
      await seedEnrollment(t.db, orgId, c.id, recordId, over);
    }
    const page = await candidatePage({ db: t.db, client: clientFor([1, 2, 3, 4, 5, 6]), cache: new MemberIdCache(), fieldMap: TEST_FIELD_MAP }, c, 1);
    const by = new Map(page.records.map((r) => [r.sfRecordId, r]));
    expect(by.get(leadId(1))).toMatchObject({ enrolled: true, enrollmentStatus: 'active', exitReason: null });
    expect(by.get(leadId(2))).toMatchObject({ enrolled: true, enrollmentStatus: 'needs_review' });
    expect(by.get(leadId(3))).toMatchObject({ enrolled: false, enrollmentStatus: 'exited', exitReason: 'deselected', skipReason: null });
    expect(by.get(leadId(4))).toMatchObject({ enrolled: true, enrollmentStatus: 'exited', exitReason: 'left_query' });
    expect(by.get(leadId(5))).toMatchObject({ enrolled: true, enrollmentStatus: 'handed_off' });
    expect(by.get(leadId(6))).toMatchObject({ enrolled: false, enrollmentStatus: null, exitReason: null });
    expect(page.activeEnrolledCount).toBe(1);
  });

  it('never counts or shows another tenant\'s enrollment, even for the same Salesforce Id', async () => {
    const orgA = await seedOrg(t.db);
    const orgB = await seedOrg(t.db);
    const a = await seedCampaign(t.db, orgA, { mode: 'ai_call', sourceKind: 'soql', listViewId: null, soql: MEMBERSHIP });
    const b = await seedCampaign(t.db, orgB, { mode: 'ai_call', sourceKind: 'soql', listViewId: null, soql: MEMBERSHIP });
    const recordB = await seedRecord(t.db, orgB, snapshot({ sfRecordId: leadId(1) }));
    await seedEnrollment(t.db, orgB, b.id, recordB, { status: 'active' });
    const page = await candidatePage({ db: t.db, client: clientFor([1]), cache: new MemberIdCache(), fieldMap: TEST_FIELD_MAP }, a, 1);
    expect(page.activeEnrolledCount).toBe(0);
    expect(page.records[0]).toMatchObject({ enrolled: false, enrollmentStatus: null });
    // Sanity: the other tenant's enrollment exists.
    expect(await t.db.select().from(schema.campaignEnrollments).where(eq(schema.campaignEnrollments.campaignId, b.id))).toHaveLength(1);
  });
});
