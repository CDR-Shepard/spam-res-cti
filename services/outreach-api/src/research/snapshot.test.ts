import type { ResearchSourceSummary } from '@cti/contracts';
import { ResearchSource } from '@cti/contracts';
import { SalesforceApiError } from '@cti/salesforce';
import { describe, expect, it } from 'vitest';
import { describeOf, fakeSalesforce, type QueryRoute, type RequestRoute } from '../test/fake-sf-client.js';
import type { ActivityItem } from './activity.js';
import { DescribeCache } from './describe.js';
import type { RecordBlock } from './related.js';
import { ResearchSnapshot, assembleSnapshot, researchRecord, snapshotHash, snapshotSize, type SnapshotInput } from './snapshot.js';

const LEAD = '00Q000000000001AAA';
const NOW = new Date('2026-10-05T12:00:00.000Z');

const block = (relation: RecordBlock['relation'], sfObject: string, fields: Array<[string, string]>): RecordBlock => ({
  relation,
  sfObject,
  id: `${sfObject}-id`,
  role: null,
  fields: fields.map(([name, value]) => ({ name, label: name, value })),
});
const item = (n: number, body = 'b'.repeat(300)): ActivityItem => ({ source: 'task', id: `T${n}`, at: `2026-09-${String(n).padStart(2, '0')}T10:00:00.000Z`, title: `Task ${n}`, body, meta: {} });
const okSource = (source: ResearchSourceSummary['source'], truncated = false): ResearchSourceSummary => ({ source, status: 'ok', count: 0, truncated, note: null });
const input = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  sfObject: 'Lead',
  sfRecordId: LEAD,
  collectedAt: NOW,
  consent: 'yes',
  records: [block('self', 'Lead', [['Name', 'Pat Seller']])],
  activity: [],
  sources: [],
  ...over,
});

describe('assembleSnapshot: activity', () => {
  it('keeps every record block, then activity newest first, and stops before the budget', () => {
    const activity = Array.from({ length: 10 }, (_, i) => item(i + 1));
    const snap = assembleSnapshot(input({ activity }), 2_000);
    expect(snap.activity.length).toBeGreaterThan(0);
    expect(snap.activity.length).toBeLessThan(10);
    expect(snap.activity.map((a) => a.id)).toEqual(['T10', 'T9', 'T8', 'T7', 'T6', 'T5', 'T4', 'T3', 'T2', 'T1'].slice(0, snap.activity.length));
    expect(snapshotSize(snap)).toBeLessThanOrEqual(2_000);
    expect(snap.truncated).toBe(true);
    expect(snap.records).toHaveLength(1);
  });

  it('fits everything under a roomy budget and is not truncated', () => {
    const snap = assembleSnapshot(input({ activity: [item(1), item(2)], sources: [okSource('tasks')] }));
    expect(snap.activity).toHaveLength(2);
    expect(snap.truncated).toBe(false);
  });

  it('says truncated when a source itself was capped', () => {
    expect(assembleSnapshot(input({ sources: [okSource('tasks', true)] })).truncated).toBe(true);
  });

  it('orders items with no date last', () => {
    const undated: ActivityItem = { ...item(1), id: 'U', at: null };
    expect(assembleSnapshot(input({ activity: [undated, item(2)] })).activity.map((a) => a.id)).toEqual(['T2', 'U']);
  });
});

describe('assembleSnapshot: record blocks over half the budget', () => {
  const self = block('self', 'Lead', [['Name', 'Pat Seller'], ['Phone', '555-0101'], ['MobilePhone', '555-0102'], ['Email', 'pat@example.com'], ['Notes__c', 'n'.repeat(600)]]);
  const contact = block('contact', 'Contact', [['Bio', 'c'.repeat(700)], ['Notes__c', 'd'.repeat(800)]]);

  it('drops the longest related values first and keeps self intact when that is enough', () => {
    const snap = assembleSnapshot(input({ records: [self, contact] }), 4_000);
    const [s, c] = snap.records;
    expect(s?.fields.map((f) => f.name)).toEqual(['Name', 'Phone', 'MobilePhone', 'Email', 'Notes__c']);
    expect(c?.fields.map((f) => f.name)).toEqual(['Bio']);
    expect(snap.truncated).toBe(true);
  });

  it('never drops self Name, Phone, MobilePhone or Email', () => {
    const snap = assembleSnapshot(input({ records: [self, contact] }), 1_200);
    const [s, c] = snap.records;
    expect(s?.fields.map((f) => f.name)).toEqual(['Name', 'Phone', 'MobilePhone', 'Email']);
    expect(c?.fields).toEqual([]);
  });

  it('never exceeds the total, even when the protected self fields alone are over it: they are truncated, consent and Id are not', () => {
    const big = block('self', 'Lead', [['Name', 'N'.repeat(3_000)], ['Phone', '5'.repeat(2_000)], ['Email', 'e'.repeat(2_500)], ['AI_Call_Consent__c', 'true'], ['Notes__c', 'n'.repeat(500)]]);
    const run = () => assembleSnapshot(input({ records: [big, contact], consentField: 'ai_call_consent__c', activity: [item(1), item(2)] }), 1_500);
    const snap = run();
    expect(snapshotSize(snap)).toBeLessThanOrEqual(1_500);
    expect(snap.consent).toBe('yes');
    const [s] = snap.records;
    expect(s?.id).toBe('Lead-id');
    expect(s?.fields.map((f) => f.name)).toEqual(['Name', 'Phone', 'Email', 'AI_Call_Consent__c']);
    expect(s?.fields.find((f) => f.name === 'AI_Call_Consent__c')?.value).toBe('true');
    expect(s?.fields.find((f) => f.name === 'Name')?.value.endsWith('…')).toBe(true);
    expect(snap.truncated).toBe(true);
    expect(run()).toEqual(snap);
  });

  it('never splits an emoji when it truncates a protected value, so the snapshot stays valid for jsonb', () => {
    const emoji = block('self', 'Lead', [['Name', '😀'.repeat(1_500)], ['Email', `x${'🏠'.repeat(1_000)}`], ['AI_Call_Consent__c', 'true']]);
    for (const total of [1_201, 1_202, 1_203, 1_500, 1_777]) {
      const snap = assembleSnapshot(input({ records: [emoji], consentField: 'AI_Call_Consent__c' }), total);
      expect(snapshotSize(snap)).toBeLessThanOrEqual(total);
      // JSON.stringify writes a lone surrogate as a \udXXX escape, which Postgres jsonb refuses.
      expect(JSON.stringify(snap)).not.toMatch(/\\ud[89a-f][0-9a-f]{2}/i);
    }
  });

  it('keeps the consent field while shorter non-key fields are dropped first', () => {
    const shorts: Array<[string, string]> = ['A', 'B', 'C', 'D', 'E', 'F'].map((k) => [`${k}__c`, 'xy']);
    const withConsent = block('self', 'Lead', [['AI_Call_Consent__c', 'true'], ['Name', 'Pat'], ...shorts]);
    const snap = assembleSnapshot(input({ records: [withConsent], consentField: 'AI_Call_Consent__c' }), 460);
    expect(snap.records[0]?.fields.map((f) => f.name)).toEqual(['AI_Call_Consent__c', 'Name']);
    expect(snapshotSize(snap)).toBeLessThanOrEqual(460);
  });

  it('Fix 1 (I-2): keeps the qualification fields of self while shorter non-key fields are dropped first', () => {
    const shorts: Array<[string, string]> = ['A', 'B', 'C', 'D', 'E', 'F'].map((k) => [`${k}__c`, 'xy']);
    const self = { ...block('self', 'Lead', [['Name', 'Pat'], ['timeline__c', '30 Days'], ['Motivation__c', 'Inherited the house from a parent'], ...shorts]), qualificationFieldsRead: ['Timeline__c', 'Motivation__c'] };
    const snap = assembleSnapshot(input({ records: [self] }), 500);
    expect(snap.records[0]?.fields.map((f) => f.name)).toEqual(['Name', 'timeline__c', 'Motivation__c']);
    expect(snap.records[0]?.qualificationFieldsRead).toEqual(['Timeline__c', 'Motivation__c']);
    expect(snapshotSize(snap)).toBeLessThanOrEqual(500);
  });

  it('Fix 1 (I-2): an Opportunity keeps its own qualification names; a related block\'s are not protected', () => {
    const self = block('self', 'Opportunity', [['Name', 'Pat'], ['SellersAskingPrice__c', '1'], ['A__c', 'x'.repeat(40)]]);
    const related = block('converted_opportunity', 'Opportunity', [['Timeline__c', '30 Days']]);
    const snap = assembleSnapshot(input({ sfObject: 'Opportunity', records: [self, related] }), 360);
    expect(snap.records.map((b) => b.fields.map((f) => f.name))).toEqual([['Name', 'SellersAskingPrice__c'], []]);
  });

  it('does not touch the blocks when they fit', () => {
    const snap = assembleSnapshot(input({ records: [self, contact] }), 10_000);
    expect(snap.records).toEqual([self, contact]);
    expect(snap.truncated).toBe(false);
  });

  it('does not mutate its input', () => {
    const before = JSON.stringify([self, contact]);
    assembleSnapshot(input({ records: [self, contact] }), 200);
    expect(JSON.stringify([self, contact])).toBe(before);
  });
});

describe('snapshotHash and the schema', () => {
  it('is stable for equal content and ignores collectedAt', () => {
    const a = assembleSnapshot(input({ activity: [item(1)] }));
    const b = assembleSnapshot(input({ activity: [item(1)], collectedAt: new Date('2027-01-01T00:00:00Z') }));
    expect(snapshotHash(a)).toBe(snapshotHash(b));
    expect(snapshotHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('changes when content or consent changes', () => {
    const a = assembleSnapshot(input({ activity: [item(1)] }));
    expect(snapshotHash(a)).not.toBe(snapshotHash(assembleSnapshot(input({ activity: [item(2)] }))));
    expect(snapshotHash(a)).not.toBe(snapshotHash(assembleSnapshot(input({ activity: [item(1)], consent: 'no' }))));
  });
  it('round-trips through the schema', () => {
    const self = { ...block('self', 'Lead', [['Name', 'Pat Seller']]), qualificationFieldsRead: ['Timeline__c'] };
    const snap = assembleSnapshot(input({ records: [self], activity: [item(1)], sources: ResearchSource.options.map((s) => okSource(s)) }));
    expect(snap.records[0]?.qualificationFieldsRead).toEqual(['Timeline__c']);
    expect(ResearchSnapshot.parse(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
  });
  it('rejects a stored snapshot of another version', () => {
    expect(ResearchSnapshot.safeParse({ ...assembleSnapshot(input()), version: 2 }).success).toBe(false);
  });
});

describe('researchRecord', () => {
  const describes = {
    Lead: describeOf('Lead', [['Id', 'id'], ['Name'], ['IsConverted', 'boolean'], ['AI_Call_Consent__c', 'boolean']]),
  };
  const happy = (): { queries: QueryRoute[]; requests: RequestRoute[] } => ({
    queries: [
      [/FROM Lead WHERE Id = /, [{ Id: LEAD, Name: 'Pat Seller', IsConverted: false, AI_Call_Consent__c: true }]],
      [/FROM Task/, [{ Id: '00T000000000001AAA', Subject: 'Call', CreatedDate: '2026-09-02T10:00:00.000Z' }]],
      [/FROM Event/, []],
      [/FROM Note/, []],
      [/FROM ContentDocumentLink/, []],
      [/FROM EmailMessage/, []],
      [/FROM FeedItem/, [{ Id: '0D5000000000001AAA', Type: 'TextPost', Body: 'Hello', CreatedDate: '2026-09-03T10:00:00.000Z', CreatedBy: { Name: 'Ann' }, CommentCount: 0 }]],
    ],
    requests: [],
  });
  const run = (sf: ReturnType<typeof fakeSalesforce>) =>
    researchRecord({ client: sf.client, describes: new DescribeCache(), orgId: 'org1' }, { sfObject: 'Lead', sfRecordId: LEAD, consentField: 'AI_Call_Consent__c', now: NOW });

  it('reads the record once, then every source, and lists all nine sources in a fixed order', async () => {
    const sf = fakeSalesforce({ describes, ...happy() });
    const snap = await run(sf);
    expect(sf.soql.filter((q) => q.includes('FROM Lead')).length).toBe(1);
    expect(sf.soql.some((q) => q.includes('FROM Task'))).toBe(true);
    expect(snap?.sources.map((s) => s.source)).toEqual(ResearchSource.options);
    expect(snap?.sources.map((s) => s.status)).toEqual(Array(9).fill('ok'));
    expect(snap?.consent).toBe('yes');
    expect(snap?.collectedAt).toBe(NOW.toISOString());
    expect(snap?.activity.map((a) => a.source)).toEqual(['chatter', 'task']);
    expect(ResearchSnapshot.safeParse(snap).success).toBe(true);
  });

  it('is null when the main record is missing', async () => {
    const q = happy();
    q.queries[0] = [/FROM Lead WHERE Id = /, []];
    const sf = fakeSalesforce({ describes, ...q });
    expect(await run(sf)).toBeNull();
    expect(sf.soql).toHaveLength(1);
  });

  it('records a degraded source and still completes', async () => {
    const q = happy();
    q.queries[5] = [/FROM EmailMessage/, new SalesforceApiError('x', 400, [{ errorCode: 'INVALID_TYPE', message: 'EmailMessage' }])];
    q.queries[6] = [/FROM FeedItem/, new SalesforceApiError('x', 400, [{ errorCode: 'INVALID_TYPE', message: 'FeedItem' }])];
    const snap = await run(fakeSalesforce({ describes, ...q }));
    const by = Object.fromEntries((snap?.sources ?? []).map((s) => [s.source, s.status]));
    expect(by).toMatchObject({ record: 'ok', tasks: 'ok', emails: 'missing', chatter: 'missing', chatter_comments: 'skipped' });
  });

  it.each([['Task', 1], ['Event', 2], ['Note', 3], ['ContentDocumentLink', 4], ['EmailMessage', 5], ['FeedItem', 6]])('a 503 from %s propagates', async (name, at) => {
    const q = happy();
    q.queries[at] = [new RegExp(`FROM ${name}`), new SalesforceApiError('down', 503, null)];
    await expect(run(fakeSalesforce({ describes, ...q }))).rejects.toThrow('down');
  });
});
