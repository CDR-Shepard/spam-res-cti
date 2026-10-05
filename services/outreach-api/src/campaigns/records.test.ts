import { describe, expect, it, vi } from 'vitest';
import type { ObjectFieldMap } from '@cti/contracts';
import type { SalesforceClient } from '@cti/salesforce';
import { fetchRecords, recordSelectSoql, snapshotFromRow, type SfRecordSnapshot } from './records.js';

const LEAD_MAP: ObjectFieldMap = {
  notes: ['Notes__c', 'Description'], phones: ['MobilePhone', 'Phone'], email: 'Email', doNotCall: 'DoNotCall', emailOptOut: 'HasOptedOutOfEmail',
  skipOnDialer: 'Skip_on_Dialer__c', consent: 'AI_Call_Consent__c', webFormSource: 'Lead_Form_Source__c', state: 'State', leadManager: 'LeadManager__c',
};
const OPP_MAP: ObjectFieldMap = {
  notes: ['Description'], phones: ['Mobile_Phone__c', 'Phone__c', 'Other_Phone__c'], email: null, doNotCall: null, emailOptOut: null,
  skipOnDialer: 'Skip_on_Dialer__c', consent: null, webFormSource: null, state: null, leadManager: null,
};
const LEAD_ID = '00Q000000000001AAA';
const OPP_ID = '006000000000001AAA';

describe('recordSelectSoql', () => {
  it('Lead: base fields, IsConverted, every mapped non-notes field, ids quoted', () => {
    expect(recordSelectSoql('Lead', LEAD_MAP, [LEAD_ID, '00Q000000000002AAA'])).toBe(
      'SELECT Id, Name, OwnerId, Owner.Name, LastModifiedDate, IsConverted, MobilePhone, Phone, Email, DoNotCall, HasOptedOutOfEmail, '
        + 'Skip_on_Dialer__c, AI_Call_Consent__c, Lead_Form_Source__c, State, LeadManager__c '
        + "FROM Lead WHERE Id IN ('00Q000000000001AAA', '00Q000000000002AAA')",
    );
  });

  it('Opportunity: IsClosed and the primary contact role subquery', () => {
    expect(recordSelectSoql('Opportunity', OPP_MAP, [OPP_ID])).toBe(
      'SELECT Id, Name, OwnerId, Owner.Name, LastModifiedDate, IsClosed, Mobile_Phone__c, Phone__c, Other_Phone__c, Skip_on_Dialer__c, '
        + '(SELECT Contact.Email, Contact.MobilePhone, Contact.Phone, Contact.DoNotCall, Contact.HasOptedOutOfEmail FROM OpportunityContactRoles WHERE IsPrimary = true LIMIT 1) '
        + "FROM Opportunity WHERE Id IN ('006000000000001AAA')",
    );
  });

  it('selects a field once (case-insensitively), never a malformed field name, and never a malformed id', () => {
    const map: ObjectFieldMap = { ...LEAD_MAP, phones: ['phone', 'MobilePhone'], leadManager: 'Name', state: "State FROM Lead WHERE Name = 'x'" };
    const soql = recordSelectSoql('Lead', map, [LEAD_ID, "x') OR Name LIKE ('%"]);
    expect(soql).toBe(
      'SELECT Id, Name, OwnerId, Owner.Name, LastModifiedDate, IsConverted, phone, MobilePhone, Email, DoNotCall, HasOptedOutOfEmail, '
        + "Skip_on_Dialer__c, AI_Call_Consent__c, Lead_Form_Source__c FROM Lead WHERE Id IN ('00Q000000000001AAA')",
    );
  });

  it('refuses to build a query with no valid id', () => {
    expect(() => recordSelectSoql('Lead', LEAD_MAP, ['nope'])).toThrow(/record id/);
  });
});

const leadRow = (over: Record<string, unknown> = {}) => ({
  attributes: { type: 'Lead', url: `/services/data/v60.0/sobjects/Lead/${LEAD_ID}` },
  Id: LEAD_ID, Name: ' Ann Seller ', OwnerId: '005000000000001AAA', Owner: { Name: 'Rep One' }, LastModifiedDate: '2026-10-03T14:05:00.000+0000',
  IsConverted: false, MobilePhone: '(305) 814-2231', Phone: '786-201-4455', Email: 'Ann@Example.com', DoNotCall: false, HasOptedOutOfEmail: false,
  Skip_on_Dialer__c: false, AI_Call_Consent__c: false, Lead_Form_Source__c: 'Website', State: 'FL', LeadManager__c: '005000000000002AAA',
  ...over,
});

describe('snapshotFromRow', () => {
  it('maps a Lead', () => {
    expect(snapshotFromRow('Lead', LEAD_MAP, leadRow())).toEqual({
      sfObject: 'Lead', sfRecordId: LEAD_ID, name: 'Ann Seller', ownerSfUserId: '005000000000001AAA', ownerName: 'Rep One', leadManagerSfUserId: '005000000000002AAA',
      phones: [{ field: 'MobilePhone', e164: '+13058142231' }, { field: 'Phone', e164: '+17862014455' }],
      email: 'Ann@Example.com', state: 'FL', webFormSource: 'Website', consentAiCall: false, sfDoNotCall: false, sfEmailOptOut: false, skipOnDialer: false,
      isClosed: false, lastModifiedAt: new Date('2026-10-03T14:05:00.000Z'),
    } satisfies SfRecordSnapshot);
  });

  it.each([
    ['unparseable numbers are dropped', { MobilePhone: 'n/a', Phone: '555-0100' }, []],
    ['a duplicate number keeps the first field', { MobilePhone: '305.814.2231', Phone: '(305) 814-2231' }, [{ field: 'MobilePhone', e164: '+13058142231' }]],
    ['blank and null fields are skipped', { MobilePhone: '  ', Phone: null }, []],
  ])('%s', (_label, over, phones) => {
    expect(snapshotFromRow('Lead', LEAD_MAP, leadRow(over))!.phones).toEqual(phones);
  });

  it.each([
    ['IsConverted → isClosed', { IsConverted: true }, { isClosed: true }],
    ['checkboxes read only when exactly true', { DoNotCall: true, HasOptedOutOfEmail: 'true', Skip_on_Dialer__c: true, AI_Call_Consent__c: true }, { sfDoNotCall: true, sfEmailOptOut: false, skipOnDialer: true, consentAiCall: true }],
    ['a queue owner has no Owner.Name', { Owner: null }, { ownerName: null }],
    ['a bad LastModifiedDate is null', { LastModifiedDate: 'yesterday' }, { lastModifiedAt: null }],
  ])('Lead: %s', (_label, over, expected) => {
    expect(snapshotFromRow('Lead', LEAD_MAP, leadRow(over))).toMatchObject(expected);
  });

  it('reads the Id from attributes.url when Id is absent, and skips a row with neither', () => {
    expect(snapshotFromRow('Lead', LEAD_MAP, leadRow({ Id: undefined }))!.sfRecordId).toBe(LEAD_ID);
    expect(snapshotFromRow('Lead', LEAD_MAP, { Name: 'x' })).toBeNull();
  });

  const oppRow = (over: Record<string, unknown> = {}, contact: Record<string, unknown> | null = null) => ({
    Id: OPP_ID, Name: 'Opp', OwnerId: '005000000000001AAA', Owner: { Name: 'Rep One' }, LastModifiedDate: '2026-10-03T14:05:00.000+0000', IsClosed: false,
    Mobile_Phone__c: null, Phone__c: null, Other_Phone__c: null, Skip_on_Dialer__c: false,
    OpportunityContactRoles: contact ? { totalSize: 1, done: true, records: [{ Contact: contact }] } : null,
    ...over,
  });

  it('Opportunity: the primary contact role fills phones and email, and ORs DoNotCall / HasOptedOutOfEmail', () => {
    const s = snapshotFromRow('Opportunity', OPP_MAP, oppRow({}, { Email: 'bob@example.com', MobilePhone: '(954) 300-1122', Phone: '(813) 260-9911', DoNotCall: true, HasOptedOutOfEmail: true }))!;
    expect(s.phones).toEqual([{ field: 'Contact.MobilePhone', e164: '+19543001122' }, { field: 'Contact.Phone', e164: '+18132609911' }]);
    expect(s).toMatchObject({ email: 'bob@example.com', sfDoNotCall: true, sfEmailOptOut: true, state: null });
  });

  it("Opportunity: its own phones come first; the contact's are added after, de-duplicated", () => {
    const s = snapshotFromRow('Opportunity', OPP_MAP, oppRow({ Mobile_Phone__c: '(305) 814-2231', Other_Phone__c: '(407) 555-2671' }, { MobilePhone: '305-814-2231', Phone: '(813) 260-9911', DoNotCall: false }))!;
    expect(s.phones).toEqual([
      { field: 'Mobile_Phone__c', e164: '+13058142231' }, { field: 'Other_Phone__c', e164: '+14075552671' }, { field: 'Contact.Phone', e164: '+18132609911' },
    ]);
    expect(s.sfDoNotCall).toBe(false);
  });

  it('Opportunity: IsClosed → isClosed; no contact role → no email', () => {
    expect(snapshotFromRow('Opportunity', OPP_MAP, oppRow({ IsClosed: true }))).toMatchObject({ isClosed: true, email: null, phones: [] });
  });

  it('Opportunity: a mapped email field wins; the contact email fills it only when blank', () => {
    const map: ObjectFieldMap = { ...OPP_MAP, email: 'Email__c' };
    expect(snapshotFromRow('Opportunity', map, oppRow({ Email__c: 'own@example.com' }, { Email: 'bob@example.com' }))!.email).toBe('own@example.com');
    expect(snapshotFromRow('Opportunity', map, oppRow({ Email__c: '' }, { Email: 'bob@example.com' }))!.email).toBe('bob@example.com');
  });
});

describe('fetchRecords', () => {
  it('fetches in batches of 200 and returns snapshots in input order, dropping ids Salesforce did not return', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `00Q${String(i).padStart(12, '0')}AAA`);
    const queryAll = vi.fn(async (soql: string, _opts?: { maxRecords?: number }) => {
      const inList = /IN \(([^)]*)\)/.exec(soql)![1]!.split(', ').map((q) => q.slice(1, -1));
      // Salesforce answers in its own order, and leaves out deleted records.
      return inList.filter((id) => id !== ids[7]).reverse().map((id) => leadRow({ Id: id, attributes: { type: 'Lead' } }));
    });
    const client = { queryAll } as unknown as SalesforceClient;
    const out = await fetchRecords(client, 'Lead', ids, LEAD_MAP);
    expect(queryAll.mock.calls.map(([soql]) => (soql.match(/'/g)!.length) / 2)).toEqual([200, 200, 50]);
    expect(queryAll.mock.calls[0]![1]).toEqual({ maxRecords: 200 });
    expect(out.map((s) => s.sfRecordId)).toEqual(ids.filter((id) => id !== ids[7]));
  });

  it('matches a 15-character input id to the 18-character Id Salesforce returns', async () => {
    const queryAll = vi.fn(async () => [leadRow()]);
    const out = await fetchRecords({ queryAll } as unknown as SalesforceClient, 'Lead', [LEAD_ID.slice(0, 15)], LEAD_MAP);
    expect(out.map((s) => s.sfRecordId)).toEqual([LEAD_ID]);
  });

  it('makes no call for no ids', async () => {
    const queryAll = vi.fn();
    expect(await fetchRecords({ queryAll } as unknown as SalesforceClient, 'Lead', [], LEAD_MAP)).toEqual([]);
    expect(queryAll).not.toHaveBeenCalled();
  });
});
