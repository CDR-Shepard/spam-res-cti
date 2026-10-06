import type { SObjectDescribe, SObjectField } from '@cti/salesforce';
import { describe, expect, it } from 'vitest';
import { fakeSalesforce } from '../test/fake-sf-client.js';
import { prodDescribe } from '../test/writeback-describes.js';
import { CHANGES_FIELD, ROLLUP_DENY, STATUS_FIELDS, readCurrent, writableFields } from './fields.js';

const f = (name: string, type: string, extra: Partial<SObjectField> = {}): SObjectField => ({ name, type, label: `${name} label`, updateable: true, calculated: false, ...extra });
const pick = (values: Array<[string, boolean]>) => values.map(([value, active]) => ({ value, label: value, active }));

describe('writableFields', () => {
  const d: SObjectDescribe = {
    name: 'Lead',
    fields: [
      f('Id', 'id', { updateable: false }),
      f('Status', 'picklist', { picklistValues: pick([['New', true], ['Working', true], ['Old Status', false]]) }),
      f('Timeline__c', 'picklist', { picklistValues: pick([['30 Days', true], ['Retired', false], ["I Didn't Ask", true]]) }),
      f('Condition__c', 'picklist', { calculated: true }),
      f('Occupancy__c', 'picklist', { updateable: false }),
      f('Next_Task_Due_Date__c', 'date'),
      f('First_Call__c', 'datetime'),
      f('Major_Repairs_Needed__c', 'multipicklist', { picklistValues: pick([['Roof', true], ['Gone', false]]) }),
      f('Roof_Issues__c', 'boolean'),
      f('Seller_s_Asking_Price__c', 'currency'),
      f('Spanish_Speaker__c', 'boolean'),
      f('DoNotCall', 'boolean'),
      f('AI_Last_Call_Changes__c', 'textarea'),
      f('Notes__c', 'textarea'),
      f('Amount_Owed__c', 'string'),
    ],
  };
  const w = writableFields(d, 'Lead');

  it('keeps only allowlisted fields the org has and the connected user can update', () => {
    expect([...w.keys()].sort()).toEqual(
      ['AI_Last_Call_Changes__c', 'DoNotCall', 'Major_Repairs_Needed__c', 'Roof_Issues__c', 'Seller_s_Asking_Price__c', 'Spanish_Speaker__c', 'Status', 'Timeline__c'].sort(),
    );
  });
  it('drops a calculated field and a field with updateable false', () => {
    expect(w.has('Condition__c')).toBe(false);
    expect(w.has('Occupancy__c')).toBe(false);
  });
  it('5a Fix 1 (M-5): drops a field whose describe does not say updateable (unknown means no)', () => {
    const { updateable: _u, ...noFlag } = f('Timeline__c', 'picklist', { picklistValues: pick([['30 Days', true]]) });
    const out = writableFields({ name: 'Lead', fields: [noFlag, f('Roof_Issues__c', 'boolean', { updateable: undefined })] }, 'Lead');
    expect([...out.keys()]).toEqual([]);
  });
  it('drops a rollup name even when the describe says it is updateable', () => {
    expect(ROLLUP_DENY.Lead.has('Next_Task_Due_Date__c')).toBe(true);
    expect(w.has('Next_Task_Due_Date__c')).toBe(false);
    expect(w.has('First_Call__c')).toBe(false);
  });
  it('keeps active picklist values only, and gives non-picklists a null picklist', () => {
    expect(w.get('Status')?.picklist).toEqual(['New', 'Working']);
    expect(w.get('Timeline__c')?.picklist).toEqual(['30 Days', "I Didn't Ask"]);
    expect(w.get('Major_Repairs_Needed__c')?.picklist).toEqual(['Roof']);
    expect(w.get('Roof_Issues__c')?.picklist).toBeNull();
  });
  it('carries the label and type from the describe and the kind from the allowlist', () => {
    expect(w.get('Timeline__c')).toEqual({ name: 'Timeline__c', label: 'Timeline__c label', type: 'picklist', picklist: ['30 Days', "I Didn't Ask"], kind: 'picklist' });
    expect(w.get('Major_Repairs_Needed__c')?.kind).toBe('multipicklist');
    expect(w.get('Seller_s_Asking_Price__c')?.kind).toBe('currency');
    expect(w.get('Spanish_Speaker__c')?.kind).toBe('boolean');
    expect(w.get('Status')?.kind).toBe('status');
    expect(w.get('DoNotCall')?.kind).toBe('status');
    expect(w.get(CHANGES_FIELD)?.kind).toBe('status');
  });
  it('drops a field missing from the org, and a qualification field whose type no longer matches its kind', () => {
    expect(w.has('Mold__c')).toBe(false);
    expect(w.has('Amount_Owed__c')).toBe(false); // currency in the allowlist, a string in this org
    expect(w.has('Notes__c')).toBe(false); // not allowlisted
  });
  it('matches allowlisted names case-insensitively and keeps the org spelling', () => {
    const lower = writableFields({ name: 'Lead', fields: [f('timeline__c', 'picklist', { picklistValues: pick([['30 Days', true]]) })] }, 'Lead');
    expect(lower.get('Timeline__c')?.name).toBe('timeline__c');
  });
  it('production describes: every allowlisted field is writable on both objects', () => {
    expect([...writableFields(prodDescribe('Lead'), 'Lead').keys()].length).toBe(20);
    const opp = writableFields(prodDescribe('Opportunity'), 'Opportunity');
    expect([...opp.keys()]).toEqual(expect.arrayContaining([...STATUS_FIELDS.Opportunity, 'Reason_For_Selling__c', 'SellersAskingPrice__c', CHANGES_FIELD]));
    expect(opp.get('Reason_For_Selling__c')?.kind).toBe('text');
  });
  it('never allows an Opportunity rollup, even if allowlisted names ever overlapped', () => {
    const opp = writableFields({ name: 'Opportunity', fields: [f('NextStep', 'string'), f('Appointment__c', 'boolean'), f('StageName', 'picklist', { picklistValues: pick([['Followup', true]]) })] }, 'Opportunity');
    expect([...opp.keys()]).toEqual(['StageName']);
  });
});

describe('readCurrent', () => {
  const LEAD_ID = '00Q8X00001AbCdEUAV';
  const OPP_ID = '0068X00001AbCdEQAZ';
  const leadRow = {
    attributes: { type: 'Lead' },
    Id: LEAD_ID,
    Name: 'Jane Seller',
    OwnerId: '0058X00000Fsx39QAB',
    LastModifiedDate: '2026-10-06T18:00:00.000+0000',
    Status: 'Long Term Follow-Up',
    Timeline__c: "I Didn't Ask",
    Street: '12 Oak St',
    City: 'Fresno',
    State: 'CA',
    PostalCode: '93701',
    IsConverted: false,
  };

  it('pins the Lead SOQL and returns values, owner, name, address and last modified', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM Lead/, [leadRow]]] });
    const r = await readCurrent(sf.client, 'Lead', LEAD_ID, ['Status', 'Timeline__c']);
    expect(sf.soql).toEqual([
      `SELECT Id, Name, OwnerId, LastModifiedDate, Status, Timeline__c, Street, City, State, PostalCode, IsConverted FROM Lead WHERE Id = '${LEAD_ID}' LIMIT 1`,
    ]);
    expect(r).toEqual({
      values: { Id: LEAD_ID, Name: 'Jane Seller', OwnerId: '0058X00000Fsx39QAB', LastModifiedDate: '2026-10-06T18:00:00.000+0000', Status: 'Long Term Follow-Up', Timeline__c: "I Didn't Ask", Street: '12 Oak St', City: 'Fresno', State: 'CA', PostalCode: '93701', IsConverted: false },
      ownerId: '0058X00000Fsx39QAB',
      name: 'Jane Seller',
      address: '12 Oak St, Fresno, CA 93701',
      lastModifiedDate: '2026-10-06T18:00:00.000+0000',
    });
  });
  it('does not repeat a base or address field the caller also asked for', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM Lead/, [leadRow]]] });
    await readCurrent(sf.client, 'Lead', LEAD_ID, ['Name', 'Status', 'City', 'status']);
    expect(sf.soql[0]).toBe(`SELECT Id, Name, OwnerId, LastModifiedDate, Status, City, Street, State, PostalCode, IsConverted FROM Lead WHERE Id = '${LEAD_ID}' LIMIT 1`);
  });
  it('no row gives null', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM Lead/, []]] });
    expect(await readCurrent(sf.client, 'Lead', LEAD_ID, ['Status'])).toBeNull();
  });
  it('a converted Lead gives null, so write-back skips it', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM Lead/, [{ ...leadRow, IsConverted: true }]]] });
    expect(await readCurrent(sf.client, 'Lead', LEAD_ID, ['Status'])).toBeNull();
  });
  it('joins the parts it has, and gives a null address when there are none', async () => {
    const partial = fakeSalesforce({ queries: [[/FROM Lead/, [{ ...leadRow, Street: '12 Oak St\nUnit 4', State: null, PostalCode: '' }]]] });
    expect((await readCurrent(partial.client, 'Lead', LEAD_ID, []))?.address).toBe('12 Oak St Unit 4, Fresno');
    const none = fakeSalesforce({ queries: [[/FROM Lead/, [{ ...leadRow, Street: null, City: null, State: null, PostalCode: null }]]] });
    expect((await readCurrent(none.client, 'Lead', LEAD_ID, []))?.address).toBeNull();
  });
  it('refuses a malformed id or field name before any query', async () => {
    const sf = fakeSalesforce({ queries: [] });
    await expect(readCurrent(sf.client, 'Lead', "00Q' OR Id != '", ['Status'])).rejects.toThrow(RangeError);
    await expect(readCurrent(sf.client, 'Lead', LEAD_ID, ['Status, (SELECT Id FROM Tasks)'])).rejects.toThrow(RangeError);
    expect(sf.soql).toEqual([]);
  });

  describe('Opportunity: the address fields come from the describe', () => {
    // _t2 (2026-10-06): Street__c, City__c, State__c (picklist) and Zipcode__c exist; Property_Address__c and Zip__c do not.
    const oppDescribe: SObjectDescribe = {
      name: 'Opportunity',
      fields: [f('Id', 'id'), f('StageName', 'picklist'), f('Street__c', 'string'), f('City__c', 'string'), f('State__c', 'picklist'), f('Zipcode__c', 'string')],
    };
    const oppRow = { Id: OPP_ID, Name: 'Jane Seller', OwnerId: '0058X00000Fsx39QAB', LastModifiedDate: '2026-10-06T18:00:00.000+0000', StageName: 'Closed Lost', Street__c: '12 Oak St', City__c: 'Fresno', State__c: 'CA', Zipcode__c: '93701' };

    it('reads the probed address fields the org has, with the describe passed in', async () => {
      const sf = fakeSalesforce({ queries: [[/FROM Opportunity/, [oppRow]]] });
      const r = await readCurrent(sf.client, 'Opportunity', OPP_ID, ['StageName'], oppDescribe);
      expect(sf.soql).toEqual([`SELECT Id, Name, OwnerId, LastModifiedDate, StageName, Street__c, City__c, State__c, Zipcode__c FROM Opportunity WHERE Id = '${OPP_ID}' LIMIT 1`]);
      expect(sf.described).toEqual([]);
      expect(r?.address).toBe('12 Oak St, Fresno, CA 93701');
    });
    it('prefers Property_Address__c and Zip__c when the org has them', async () => {
      const d = { ...oppDescribe, fields: [...oppDescribe.fields, f('Property_Address__c', 'string'), f('Zip__c', 'string')] };
      const sf = fakeSalesforce({ queries: [[/FROM Opportunity/, [{ ...oppRow, Property_Address__c: '9 Elm Ave', Zip__c: '93702' }]]] });
      const r = await readCurrent(sf.client, 'Opportunity', OPP_ID, [], d);
      expect(sf.soql[0]).toBe(`SELECT Id, Name, OwnerId, LastModifiedDate, Property_Address__c, Street__c, City__c, State__c, Zip__c, Zipcode__c FROM Opportunity WHERE Id = '${OPP_ID}' LIMIT 1`);
      expect(r?.address).toBe('9 Elm Ave, Fresno, CA 93702');
    });
    it('describes the Opportunity itself when no describe is passed', async () => {
      const sf = fakeSalesforce({ describes: { Opportunity: oppDescribe }, queries: [[/FROM Opportunity/, [oppRow]]] });
      expect((await readCurrent(sf.client, 'Opportunity', OPP_ID, ['StageName']))?.address).toBe('12 Oak St, Fresno, CA 93701');
      expect(sf.described).toEqual(['Opportunity']);
    });
    it('an org with none of the address fields gives a null address', async () => {
      const sf = fakeSalesforce({ queries: [[/FROM Opportunity/, [oppRow]]] });
      const r = await readCurrent(sf.client, 'Opportunity', OPP_ID, ['StageName'], { name: 'Opportunity', fields: [f('StageName', 'picklist')] });
      expect(sf.soql[0]).toBe(`SELECT Id, Name, OwnerId, LastModifiedDate, StageName FROM Opportunity WHERE Id = '${OPP_ID}' LIMIT 1`);
      expect(r?.address).toBeNull();
    });
  });
});
