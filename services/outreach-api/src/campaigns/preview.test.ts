import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { FieldMap, ObjectFieldMap } from '@cti/contracts';
import type { ConsentBlock } from '@cti/firewall';
import { SalesforceApiError, type SalesforceClient } from '@cti/salesforce';
import { fakeDb } from '../test/harness.js';
import { PREVIEW_EXAMINE_LIMIT, previewCampaign } from './preview.js';

const fw = vi.hoisted(() => ({ blocked: vi.fn() }));
vi.mock('@cti/firewall', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/firewall')>()),
  blockedTargets: fw.blocked,
}));

const LEAD_MAP: ObjectFieldMap = {
  notes: ['Notes__c'], phones: ['MobilePhone', 'Phone'], email: 'Email', doNotCall: 'DoNotCall', emailOptOut: 'HasOptedOutOfEmail',
  skipOnDialer: null, consent: null, webFormSource: null, state: 'State', leadManager: null,
};
const FIELD_MAP: FieldMap = { Lead: LEAD_MAP, Opportunity: { ...LEAD_MAP, phones: [], email: null, doNotCall: null, emailOptOut: null, state: null } };
const MEMBERSHIP = "SELECT Id FROM Lead WHERE Status = 'Open'";
const id = (n: number) => `00Q${String(n).padStart(12, '0')}AAA`;

function leadRow(n: number, over: Record<string, unknown> = {}) {
  return { Id: id(n), Name: `Lead ${n}`, OwnerId: '005000000000001AAA', Owner: { Name: 'Rep One' }, LastModifiedDate: '2026-10-03T14:05:00.000+0000', IsConverted: false, MobilePhone: null, Phone: null, Email: null, DoNotCall: false, HasOptedOutOfEmail: false, State: 'FL', ...over };
}

/** Membership query → member rows; the record fetch → the rows for the ids in its IN (...). */
function stubClient(members: number[], rows: Map<string, Record<string, unknown>>) {
  const queryAll = vi.fn(async (soql: string) => {
    if (soql === MEMBERSHIP) return members.map((n) => ({ Id: id(n) }));
    const inList = /IN \(([^)]*)\)/.exec(soql)![1]!.split(', ').map((q) => q.slice(1, -1));
    return inList.flatMap((rid) => (rows.has(rid) ? [rows.get(rid)!] : []));
  });
  return { queryAll, client: { queryAll, listViewSoql: vi.fn() } as unknown as SalesforceClient };
}

beforeEach(() => fw.blocked.mockReset().mockResolvedValue(new Map<string, ConsentBlock>()));

describe('previewCampaign', () => {
  it('counts members, eligibility and skip reasons, and samples in query order', async () => {
    const rows = new Map([
      [id(1), leadRow(1, { MobilePhone: '(305) 814-2231', Email: 'one@example.com' })],
      [id(2), leadRow(2, { Phone: '786-201-4455', IsConverted: true })],
      [id(3), leadRow(3, { Phone: '(954) 300-1122' })],
      [id(4), leadRow(4, { Phone: '(813) 260-9911', Email: 'Taken@Example.com' })],
      [id(5), leadRow(5)],
    ]);
    fw.blocked.mockResolvedValue(new Map<string, ConsentBlock>([['+19543001122', 'opted_out']]));
    const { db, captured } = fakeDb({ selectResults: [[{ key: 'taken@example.com' }]] });
    const { client } = stubClient([1, 2, 3, 4, 5], rows);
    const preview = await previewCampaign({ db, client, orgId: 'O1', fieldMap: FIELD_MAP }, { sfObject: 'Lead', source: { kind: 'soql', soql: MEMBERSHIP } });
    expect(preview).toEqual({
      total: 5,
      examined: 5,
      eligible: 1,
      skipped: { closed: 1, opted_out: 1, in_other_campaign: 1, no_contact_point: 1 },
      sample: [
        { sfRecordId: id(1), name: 'Lead 1', ownerName: 'Rep One', channels: ['call', 'sms', 'email'], skipReason: null },
        { sfRecordId: id(2), name: 'Lead 2', ownerName: 'Rep One', channels: ['call'], skipReason: 'closed' },
        { sfRecordId: id(3), name: 'Lead 3', ownerName: 'Rep One', channels: [], skipReason: 'opted_out' },
        { sfRecordId: id(4), name: 'Lead 4', ownerName: 'Rep One', channels: ['call', 'email'], skipReason: 'in_other_campaign' },
        { sfRecordId: id(5), name: 'Lead 5', ownerName: 'Rep One', channels: [], skipReason: 'no_contact_point' },
      ],
    });
    expect(fw.blocked).toHaveBeenCalledWith(db, 'O1', ['+13058142231', '+17862014455', '+19543001122', '+18132609911']);
    // in_other_campaign looks only at this tenant's ACTIVE keys, for exactly these people.
    const keysQuery = new PgDialect().sqlToQuery(captured.where.at(-1) as SQL);
    expect(keysQuery.sql).toBe('("enrollment_contact_keys"."org_id" = $1 and "enrollment_contact_keys"."active" = $2 and "enrollment_contact_keys"."key" in ($3, $4, $5, $6, $7, $8))');
    expect(keysQuery.params).toEqual(['O1', true, '+13058142231', 'one@example.com', '+17862014455', '+19543001122', '+18132609911', 'taken@example.com']);
  });

  it(`counts every member for total but fetches fields for only the first ${PREVIEW_EXAMINE_LIMIT}`, async () => {
    const members = Array.from({ length: 2_050 }, (_, i) => i + 1);
    const rows = new Map(members.map((n) => [id(n), leadRow(n, { Email: `p${n}@example.com` })]));
    const { client, queryAll } = stubClient(members, rows);
    const preview = await previewCampaign({ db: fakeDb().db, client, orgId: 'O1', fieldMap: FIELD_MAP }, { sfObject: 'Lead', source: { kind: 'soql', soql: MEMBERSHIP } });
    expect(preview).toMatchObject({ total: 2_050, examined: 2_000, eligible: 2_000, skipped: {} });
    expect(preview.sample).toHaveLength(20);
    expect(queryAll).toHaveBeenCalledTimes(11); // one membership read (a single page here) + 10 record batches of 200
  });

  it('rejects a bad source before calling Salesforce', async () => {
    const { client, queryAll } = stubClient([], new Map());
    await expect(previewCampaign({ db: fakeDb().db, client, orgId: 'O1', fieldMap: FIELD_MAP }, { sfObject: 'Lead', source: { kind: 'soql', soql: 'SELECT Id FROM Contact' } }))
      .rejects.toMatchObject({ code: 'invalid_soql' });
    expect(queryAll).not.toHaveBeenCalled();
  });

  it('turns a list view into its described SOQL (one describe call), then previews as usual', async () => {
    const rows = new Map([[id(1), leadRow(1, { MobilePhone: '(305) 814-2231' })]]);
    const { queryAll } = stubClient([1], rows);
    const listViewSoql = vi.fn(async () => MEMBERSHIP);
    const client = { queryAll, listViewSoql } as unknown as SalesforceClient;
    const preview = await previewCampaign({ db: fakeDb().db, client, orgId: 'O1', fieldMap: FIELD_MAP }, { sfObject: 'Lead', source: { kind: 'list_view', listViewId: '00B5f00000ABCDE' } });
    expect(listViewSoql).toHaveBeenCalledWith('Lead', '00B5f00000ABCDE');
    expect(preview).toMatchObject({ total: 1, examined: 1, eligible: 1 });
    expect(queryAll).toHaveBeenCalledTimes(2); // membership + 1 record batch
  });

  it("reports a Salesforce error from the record fetch in Salesforce's words", async () => {
    const queryAll = vi.fn(async (soql: string) => {
      if (soql === MEMBERSHIP) return [{ Id: id(1) }];
      throw new SalesforceApiError('query failed (400)', 400, [{ errorCode: 'INVALID_FIELD', message: "No such column 'State' on entity 'Lead'" }]);
    });
    const client = { queryAll, listViewSoql: vi.fn() } as unknown as SalesforceClient;
    await expect(previewCampaign({ db: fakeDb().db, client, orgId: 'O1', fieldMap: FIELD_MAP }, { sfObject: 'Lead', source: { kind: 'soql', soql: MEMBERSHIP } }))
      .rejects.toMatchObject({ code: 'salesforce_error', message: "INVALID_FIELD: No such column 'State' on entity 'Lead'" });
  });
});
