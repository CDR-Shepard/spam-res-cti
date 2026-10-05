import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { leadId, seedCampaign, seedOrg } from '../test/outreach-fixtures.js';
import { allSelectedIds, clearSelection, deselectRecords, selectedAmong, selectedCount, selectRecords } from './selection.js';

describe.skipIf(!pgLane)('campaign selections (real Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 120_000);
  afterAll(async () => { await t?.drop(); });

  it('adds idempotently, removes, counts, and clears per campaign', async () => {
    const orgId = await seedOrg(t.db);
    const c = await seedCampaign(t.db, orgId, { mode: 'ai_call' });
    const other = await seedCampaign(t.db, orgId, { mode: 'ai_call' });
    const ids = [leadId(1), leadId(2), leadId(3)];
    expect(await selectRecords(t.db, { orgId, campaignId: c.id, userId: null, sfRecordIds: ids })).toBe(3);
    expect(await selectRecords(t.db, { orgId, campaignId: c.id, userId: null, sfRecordIds: [leadId(1)] })).toBe(0);
    await selectRecords(t.db, { orgId, campaignId: other.id, userId: null, sfRecordIds: [leadId(9)] });
    expect(await deselectRecords(t.db, c.id, [leadId(2)])).toBe(1);
    expect(await selectedCount(t.db, c.id)).toBe(2);
    expect([...(await selectedAmong(t.db, c.id, [leadId(1), leadId(2), leadId(9)]))]).toEqual([leadId(1)]);
    expect(await allSelectedIds(t.db, c.id)).toEqual(new Set([leadId(1), leadId(3)]));
    expect(await clearSelection(t.db, c.id)).toBe(2);
    expect(await selectedCount(t.db, other.id)).toBe(1);
  });

  it('selects 50,000 ids in batches without hitting the bind-parameter limit', async () => {
    const orgId = await seedOrg(t.db);
    const c = await seedCampaign(t.db, orgId, { mode: 'ai_call' });
    const ids = Array.from({ length: 50_000 }, (_, i) => leadId(i + 1));
    expect(await selectRecords(t.db, { orgId, campaignId: c.id, userId: null, sfRecordIds: ids })).toBe(50_000);
  }, 60_000);
});
