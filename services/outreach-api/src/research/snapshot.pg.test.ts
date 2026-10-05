/** Real Postgres: a snapshot cut in the middle of an emoji is still accepted by jsonb. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Db } from '@cti/db';
import { createTestDb, pgLane } from '../test/pg.js';
import { assembleSnapshot } from './snapshot.js';
import { clip } from './text.js';

describe.skipIf(!pgLane)('research snapshots in jsonb (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  it('stores snapshots whose protected value and activity body were cut mid-emoji', async () => {
    for (let total = 1_201; total <= 1_210; total++) {
      const snapshot = assembleSnapshot(
        {
          sfObject: 'Lead',
          sfRecordId: '00Q000000000001AAA',
          collectedAt: new Date('2026-10-05T12:00:00.000Z'),
          consent: 'yes',
          consentField: 'AI_Call_Consent__c',
          records: [{ relation: 'self', sfObject: 'Lead', id: '00Q000000000001AAA', role: null, fields: [{ name: 'Name', label: 'Name', value: '😀'.repeat(1_500) }] }],
          // 'x' then pairs: a 10-unit cut ends on the first half of the fifth emoji.
          activity: [{ source: 'chatter', id: '0D5000000000001AAA', at: '2026-10-01T10:00:00.000Z', title: null, body: clip(`x${'🏡'.repeat(20)}`, 10).text, meta: {} }],
          sources: [],
        },
        total,
      );
      expect(snapshot.activity).toHaveLength(1);
      const result = await db.execute(sql`select ${JSON.stringify(snapshot)}::jsonb as j`);
      expect((result as unknown as { rows: Array<{ j: unknown }> }).rows[0]!.j).toEqual(snapshot);
    }
  });

  it('stores a snapshot whose Salesforce values hold a lone surrogate (and a NUL), well-formed, as jsonb', async () => {
    const lone = `bad\ud83d text\ude00 end\u0000`;
    const snapshot = assembleSnapshot({
      sfObject: 'Lead',
      sfRecordId: '00Q000000000001AAA',
      collectedAt: new Date('2026-10-05T12:00:00.000Z'),
      consent: 'yes',
      records: [{ relation: 'self', sfObject: 'Lead', id: '00Q000000000001AAA', role: null, fields: [{ name: 'Name', label: 'Name', value: lone }] }],
      activity: [{ source: 'task', id: '00T000000000001AAA', at: '2026-10-01T10:00:00.000Z', title: lone, body: lone, meta: { starts: lone } }],
      sources: [{ source: 'tasks', status: 'error', count: 0, truncated: false, note: lone }],
    });
    const result = await db.execute(sql`select ${JSON.stringify(snapshot)}::jsonb as j`);
    expect((result as unknown as { rows: Array<{ j: unknown }> }).rows[0]!.j).toEqual(snapshot);
    expect(snapshot.records[0]!.fields[0]!.value).toBe('bad\ufffd text\ufffd end');
  });
});
