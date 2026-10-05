import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CampaignRow } from '@cti/db';
import type { FieldMap, ObjectFieldMap } from '@cti/contracts';
import type { ConsentBlock } from '@cti/firewall';
import type { SalesforceClient } from '@cti/salesforce';
import { fakeDb } from '../test/harness.js';
import { candidatePage } from './candidates.js';
import { MemberIdCache } from './member-cache.js';

const mocks = vi.hoisted(() => ({
  blocked: vi.fn(),
  activeKeys: vi.fn(),
  selectedAmong: vi.fn(),
  selectedCount: vi.fn(),
}));
vi.mock('@cti/firewall', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/firewall')>()),
  blockedTargets: mocks.blocked,
}));
vi.mock('./preview.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./preview.js')>()),
  activeContactKeys: mocks.activeKeys,
}));
vi.mock('./selection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./selection.js')>()),
  selectedAmong: mocks.selectedAmong,
  selectedCount: mocks.selectedCount,
}));

const LEAD_MAP: ObjectFieldMap = {
  notes: [], phones: ['MobilePhone'], email: null, doNotCall: null, emailOptOut: null,
  skipOnDialer: null, consent: 'AI_Call_Consent__c', webFormSource: null, state: null, leadManager: null,
};
const FIELD_MAP: FieldMap = { Lead: LEAD_MAP, Opportunity: { ...LEAD_MAP, consent: null } };
const MEMBERSHIP = 'SELECT Id FROM Lead';
const campaign = { id: 'C1', orgId: 'O1', sfObject: 'Lead', sourceKind: 'soql', listViewId: null, soql: MEMBERSHIP, mode: 'ai_call' } as unknown as CampaignRow;
const id = (n: number) => `00Q${String(n).padStart(12, '0')}AAA`;
const phone = (n: number) => `+1305814${String(1000 + n)}`;

function leadRow(n: number, over: Record<string, unknown> = {}) {
  return { Id: id(n), Name: `Lead ${n}`, OwnerId: '005000000000001AAA', Owner: { Name: 'Rep One' }, LastModifiedDate: '2026-10-03T14:05:00.000+0000', IsConverted: false, MobilePhone: phone(n), AI_Call_Consent__c: false, ...over };
}

/** Membership query → the member Ids; a record query → the rows for the ids in its IN (...). */
function stubClient(memberCount: number, rows: (n: number) => Record<string, unknown> | null = (n) => leadRow(n)) {
  const queryAll = vi.fn(async (soql: string) => {
    if (soql === MEMBERSHIP) return Array.from({ length: memberCount }, (_, i) => ({ Id: id(i + 1) }));
    const ids = /IN \(([^)]*)\)/.exec(soql)![1]!.split(', ').map((q) => Number(q.slice(4, 16)));
    return ids.flatMap((n) => { const r = rows(n); return r ? [r] : []; });
  });
  return { queryAll, client: { queryAll } as unknown as SalesforceClient };
}

const recordQueries = (queryAll: ReturnType<typeof vi.fn>) => queryAll.mock.calls.map((c) => c[0] as string).filter((s) => s !== MEMBERSHIP);

beforeEach(() => {
  mocks.blocked.mockReset().mockResolvedValue(new Map<string, ConsentBlock>());
  mocks.activeKeys.mockReset().mockResolvedValue(new Set<string>());
  mocks.selectedAmong.mockReset().mockResolvedValue(new Set<string>());
  mocks.selectedCount.mockReset().mockResolvedValue(0);
});

describe('candidatePage', () => {
  it('fetches page 2 of 120 members in one record query', async () => {
    const { client, queryAll } = stubClient(120);
    const { db } = fakeDb();
    const page = await candidatePage({ db, client, cache: new MemberIdCache(), fieldMap: FIELD_MAP }, campaign, 2);
    expect(page).toMatchObject({ total: 120, page: 2, pages: 3, pageSize: 50 });
    expect(page.records.map((r) => r.sfRecordId)).toEqual(Array.from({ length: 50 }, (_, i) => id(51 + i)));
    const queries = recordQueries(queryAll);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain(`'${id(51)}'`);
    expect(queries[0]).toContain(`'${id(100)}'`);
    expect(queries[0]).not.toContain(`'${id(50)}'`);
    expect(queries[0]).not.toContain(`'${id(101)}'`);
  });

  it('clamps a page past the end to the last, and page 0 to the first', async () => {
    const { client } = stubClient(120);
    const { db } = fakeDb();
    const deps = { db, client, cache: new MemberIdCache(), fieldMap: FIELD_MAP };
    expect(await candidatePage(deps, campaign, 99)).toMatchObject({ page: 3, pages: 3 });
    expect((await candidatePage(deps, campaign, 99)).records).toHaveLength(20);
    expect(await candidatePage(deps, campaign, 0)).toMatchObject({ page: 1 });
  });

  it('leaves out a member Salesforce no longer returns; total is unchanged', async () => {
    const { client } = stubClient(3, (n) => (n === 2 ? null : leadRow(n)));
    const { db } = fakeDb();
    const page = await candidatePage({ db, client, cache: new MemberIdCache(), fieldMap: FIELD_MAP }, campaign, 1);
    expect(page.total).toBe(3);
    expect(page.records.map((r) => r.sfRecordId)).toEqual([id(1), id(3)]);
  });

  it("an already-enrolled member is enrolled with no skip reason, even though its keys are active (they are its own)", async () => {
    const { client } = stubClient(2);
    const { db } = fakeDb({ selectResults: [[{ id: id(1), status: 'active', exitReason: null }]] });
    mocks.activeKeys.mockImplementation(async (_db, _org, keys: string[]) => new Set(keys));
    const page = await candidatePage({ db, client, cache: new MemberIdCache(), fieldMap: FIELD_MAP }, campaign, 1);
    expect(mocks.activeKeys.mock.calls[0]![2]).toEqual([phone(2)]);
    expect(page.records[0]).toMatchObject({ sfRecordId: id(1), enrolled: true, skipReason: null });
    expect(page.records[1]).toMatchObject({ sfRecordId: id(2), enrolled: false, skipReason: 'in_other_campaign' });
  });

  it("a member whose key another campaign holds is 'in_other_campaign'", async () => {
    const { client } = stubClient(2);
    const { db } = fakeDb();
    mocks.activeKeys.mockResolvedValue(new Set([phone(1)]));
    const page = await candidatePage({ db, client, cache: new MemberIdCache(), fieldMap: FIELD_MAP }, campaign, 1);
    expect(page.records.map((r) => r.skipReason)).toEqual(['in_other_campaign', null]);
  });

  it("marks selected members; selectedCount is the campaign's total, not the page's", async () => {
    const { client } = stubClient(3);
    const { db } = fakeDb();
    mocks.selectedAmong.mockResolvedValue(new Set([id(2)]));
    mocks.selectedCount.mockResolvedValue(40);
    const page = await candidatePage({ db, client, cache: new MemberIdCache(), fieldMap: FIELD_MAP }, campaign, 1);
    expect(page.records.map((r) => r.selected)).toEqual([false, true, false]);
    expect(page.selectedCount).toBe(40);
  });

  it('copies consentAiCall from the snapshot (AI_Call_Consent__c through the field map)', async () => {
    const { client } = stubClient(2, (n) => leadRow(n, { AI_Call_Consent__c: n === 2 }));
    const { db } = fakeDb();
    const page = await candidatePage({ db, client, cache: new MemberIdCache(), fieldMap: FIELD_MAP }, campaign, 1);
    expect(page.records.map((r) => r.consentAiCall)).toEqual([false, true]);
  });

  it('serves the second page from the cached member ids (one membership query)', async () => {
    const { client, queryAll } = stubClient(120);
    const { db } = fakeDb();
    const deps = { db, client, cache: new MemberIdCache(), fieldMap: FIELD_MAP };
    await candidatePage(deps, campaign, 1);
    await candidatePage(deps, campaign, 2);
    expect(queryAll.mock.calls.filter((c) => c[0] === MEMBERSHIP)).toHaveLength(1);
  });
});
