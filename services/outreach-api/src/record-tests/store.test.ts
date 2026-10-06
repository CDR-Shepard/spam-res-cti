/** Real Postgres: the ai_record_tests store (plan 1E Task 3): read-time interruption, org scoping, the running guard, the list. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { RecordTest, RecordTestsResponse } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { seedUser } from '../test/call-plan-seed.js';
import { seedConnection, seedOrg } from '../test/outreach-fixtures.js';
import { RT_FIELD_MAP } from '../test/record-test-org.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { finishRecordTest, insertRecordTest, listRecordTests, loadInstanceUrl, loadRecordTest, PREVIEW_STALE_MS, RECORD_TEST_LIST_LIMIT, toRecordTest } from './store.js';

const NOW = new Date('2026-10-06T16:00:00.000Z');
const LEAD = '00Q8X00001AbCdEUAV';
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe.skipIf(!pgLane)('record test store (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  async function tenant() {
    const orgId = await seedOrg(db);
    const admin = await seedUser(db, orgId, { displayName: 'Ada Admin' });
    return { orgId, admin };
  }
  const insert = async (t: { orgId: string; admin: string }, createdAt: Date) => {
    const id = await insertRecordTest(db, { orgId: t.orgId, requestedBy: t.admin, sfObject: 'Lead', sfRecordId: LEAD });
    await db.update(schema.aiRecordTests).set({ createdAt }).where(eq(schema.aiRecordTests.id, id));
    return id;
  };
  const stored = async (id: string) => (await db.select().from(schema.aiRecordTests).where(eq(schema.aiRecordTests.id, id)))[0]!;

  it('10: a running row created 7 minutes ago reads as failed: interrupted; the stored row is unchanged', async () => {
    const t = await tenant();
    const id = await insert(t, ago(7 * 60_000));
    const read = await loadRecordTest(db, t.orgId, id, NOW);
    expect(read).toMatchObject({ status: 'failed', error: 'interrupted', requestedByName: 'Ada Admin' });
    expect(await stored(id)).toMatchObject({ status: 'running', error: null });
    const fresh = await insert(t, ago(PREVIEW_STALE_MS - 1_000));
    expect(await loadRecordTest(db, t.orgId, fresh, NOW)).toMatchObject({ status: 'running', error: null });
    expect(RecordTest.parse(toRecordTest(read!, [], null))).toMatchObject({ status: 'failed', error: 'interrupted', plan: null, slots: [] });
  });

  it("11: another org's test, or an id that does not exist, is null", async () => {
    const a = await tenant();
    const b = await tenant();
    const id = await insert(a, NOW);
    expect(await loadRecordTest(db, b.orgId, id, NOW)).toBeNull();
    expect(await loadRecordTest(db, a.orgId, '00000000-0000-4000-8000-000000000000', NOW)).toBeNull();
  });

  it('12: finishing a row that is no longer running changes nothing', async () => {
    const t = await tenant();
    const id = await insert(t, NOW);
    await finishRecordTest(db, id, { error: 'not_found' }, NOW);
    const failed = await stored(id);
    expect(failed).toMatchObject({ status: 'failed', error: 'not_found', completedAt: NOW });
    await finishRecordTest(db, id, { error: 'timeout', usage: { model: 'm', inputTokens: 1, outputTokens: 1, costMicros: 5 } }, new Date(NOW.getTime() + 1_000));
    expect(await stored(id)).toEqual(failed);
  });

  it('12b (E-1): a finish that comes after the row reads as interrupted changes nothing, so the overlap can never surface', async () => {
    const t = await tenant();
    const late = await insert(t, ago(PREVIEW_STALE_MS + 60_000));
    await finishRecordTest(db, late, { error: 'not_found' }, NOW);
    expect(await stored(late)).toMatchObject({ status: 'running', error: null, completedAt: null });
    expect(await loadRecordTest(db, t.orgId, late, NOW)).toMatchObject({ status: 'failed', error: 'interrupted' });
    const inTime = await insert(t, ago(PREVIEW_STALE_MS - 60_000));
    await finishRecordTest(db, inTime, { error: 'not_found' }, NOW);
    expect(await stored(inTime)).toMatchObject({ status: 'failed', error: 'not_found' });
  });

  it('12c (E-1): the instance URL is read alone, for the org', async () => {
    const t = await tenant();
    expect(await loadInstanceUrl(db, t.orgId)).toBeNull();
    await seedConnection(db, t.orgId, RT_FIELD_MAP);
    expect(await loadInstanceUrl(db, t.orgId)).toMatch(/^https:\/\//);
  });

  it('13: the list is this org only, newest first, at most 20, with who asked', async () => {
    const t = await tenant();
    const other = await tenant();
    await insert(other, NOW);
    const ids: string[] = [];
    for (let i = 0; i < RECORD_TEST_LIST_LIMIT + 2; i++) ids.push(await insert(t, ago((25 - i) * 60_000)));
    const list = await listRecordTests(db, t.orgId, NOW);
    expect(RecordTestsResponse.parse(list)).toEqual(list);
    expect(list.items).toHaveLength(RECORD_TEST_LIST_LIMIT);
    expect(list.items.map((i) => i.id)).toEqual([...ids].reverse().slice(0, RECORD_TEST_LIST_LIMIT));
    expect(list.items[0]).toMatchObject({ sfObject: 'Lead', sfRecordId: LEAD, requestedByName: 'Ada Admin', status: 'running' });
    // The newest is 4 minutes old and running; the oldest shown (23 minutes, still running) reads as interrupted, as the detail does.
    expect(list.items.at(-1)?.status).toBe('failed');
  });

  it('a drifted row reads as nulls and empty lists, never a throw (1D D-6)', async () => {
    const t = await tenant();
    const id = await insert(t, NOW);
    await db.update(schema.aiRecordTests).set({ status: 'ready', plan: { opener: 1 }, research: { version: 9 }, slots: [{ id: 'x' }], planTextIssues: { not: 'a list' } as unknown as string[], error: 'odd' }).where(eq(schema.aiRecordTests.id, id));
    const read = (await loadRecordTest(db, t.orgId, id, NOW))!;
    const api = toRecordTest(read, [], 'https://example.my.salesforce.com/');
    expect(RecordTest.parse(api)).toMatchObject({ plan: null, consent: null, sources: [], slots: [], planTextWords: [], error: null, returning: false });
    expect(api.recordUrl).toBe(`https://example.my.salesforce.com/${LEAD}`);
  });
});
