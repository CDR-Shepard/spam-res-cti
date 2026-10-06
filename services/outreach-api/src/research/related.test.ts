import { SalesforceApiError } from '@cti/salesforce';
import { describe, expect, it } from 'vitest';
import { describeOf, fakeSalesforce, type QueryRoute } from '../test/fake-sf-client.js';
import { DescribeCache } from './describe.js';
import { readMainAndRelated, type ResearchReadDeps } from './related.js';

const LEAD = '00Q000000000001AAA';
const CONTACT = '003000000000001AAA';
const ACCOUNT = '001000000000001AAA';
const OPP = '006000000000001AAA';
const CONTACT2 = '003000000000002AAA';

const leadDescribe = describeOf('Lead', [
  ['Name'], ['Id', 'id'], ['Phone', 'phone'], ['Photo__c', 'base64'], ['DoNotCall', 'boolean'], ['IsConverted', 'boolean'],
  ['ConvertedContactId', 'reference'], ['ConvertedAccountId', 'reference'], ['ConvertedOpportunityId', 'reference'],
  ['AI_Call_Consent__c', 'boolean'], ['Notes__c', 'textarea'],
]);
const describes = {
  Lead: leadDescribe,
  Contact: describeOf('Contact', [['Id', 'id'], ['Name'], ['Email', 'email']]),
  Account: describeOf('Account', [['Id', 'id'], ['Name']]),
  Opportunity: describeOf('Opportunity', [['Id', 'id'], ['Name'], ['AccountId', 'reference'], ['AI_Call_Consent__c', 'boolean']]),
};

const deps = (sf: ReturnType<typeof fakeSalesforce>): ResearchReadDeps => ({ client: sf.client, describes: new DescribeCache(), orgId: 'org1' });
const lead = (extra: Record<string, unknown> = {}) => ({ Id: LEAD, Name: 'Pat Seller', Phone: '555', DoNotCall: false, IsConverted: false, AI_Call_Consent__c: true, ...extra });
const leadRoute = (row: Record<string, unknown> | null): QueryRoute => [/FROM Lead WHERE Id = /, row ? [row] : []];

describe('readMainAndRelated: a Lead', () => {
  it('not converted: one describe, one query, every readable field, Id first, binary dropped', async () => {
    const sf = fakeSalesforce({ describes, queries: [leadRoute(lead())] });
    const got = await readMainAndRelated(deps(sf), { sfObject: 'Lead', sfRecordId: LEAD, consentField: 'AI_Call_Consent__c' });
    expect(sf.described).toEqual(['Lead']);
    expect(sf.soql).toEqual([
      `SELECT Id, AI_Call_Consent__c, Name, Phone, DoNotCall, IsConverted, ConvertedContactId, ConvertedAccountId, ConvertedOpportunityId, Notes__c FROM Lead WHERE Id = '${LEAD}' LIMIT 1`,
    ]);
    expect(got?.related.summary).toEqual({ source: 'related', status: 'ok', count: 0, truncated: false, note: null });
    expect(got?.links).toEqual({ whoIds: [LEAD], whatIds: [], parentIds: [LEAD] });
    expect(got?.main).toMatchObject({ relation: 'self', sfObject: 'Lead', id: LEAD, role: null });
  });

  it('converted: reads the Contact, Account and Opportunity and links them', async () => {
    const sf = fakeSalesforce({
      describes,
      queries: [
        leadRoute(lead({ IsConverted: true, ConvertedContactId: CONTACT, ConvertedAccountId: ACCOUNT, ConvertedOpportunityId: OPP })),
        [/FROM Contact WHERE Id = /, [{ Id: CONTACT, Name: 'Pat', Email: 'p@x.com' }]],
        [/FROM Account WHERE Id = /, [{ Id: ACCOUNT, Name: 'Seller family' }]],
        [/FROM Opportunity WHERE Id = /, [{ Id: OPP, Name: 'Oak St' }]],
      ],
    });
    const got = await readMainAndRelated(deps(sf), { sfObject: 'Lead', sfRecordId: LEAD, consentField: null });
    expect(got?.related.items.map((b) => [b.relation, b.sfObject, b.id])).toEqual([
      ['converted_contact', 'Contact', CONTACT],
      ['converted_account', 'Account', ACCOUNT],
      ['converted_opportunity', 'Opportunity', OPP],
    ]);
    expect(got?.links).toEqual({ whoIds: [LEAD, CONTACT], whatIds: [ACCOUNT, OPP], parentIds: [LEAD, CONTACT, ACCOUNT, OPP] });
  });

  it('ignores a malformed Converted*Id and never interpolates it', async () => {
    const sf = fakeSalesforce({
      describes,
      queries: [leadRoute(lead({ IsConverted: true, ConvertedContactId: "x' OR Id != '", ConvertedAccountId: ACCOUNT })), [/FROM Account WHERE Id = /, [{ Id: ACCOUNT, Name: 'A' }]]],
    });
    const got = await readMainAndRelated(deps(sf), { sfObject: 'Lead', sfRecordId: LEAD, consentField: null });
    expect(got?.related.items.map((b) => b.id)).toEqual([ACCOUNT]);
    expect(sf.soql.join('\n')).not.toContain('OR Id');
  });

  it('is null when Salesforce returns no row', async () => {
    const sf = fakeSalesforce({ describes, queries: [leadRoute(null)] });
    expect(await readMainAndRelated(deps(sf), { sfObject: 'Lead', sfRecordId: LEAD, consentField: null })).toBeNull();
  });

  it('refuses a malformed record id before any request', async () => {
    const sf = fakeSalesforce({ describes });
    await expect(readMainAndRelated(deps(sf), { sfObject: 'Lead', sfRecordId: "bad'id", consentField: null })).rejects.toThrow();
    expect(sf.soql).toEqual([]);
    expect(sf.described).toEqual([]);
  });
});

describe('readMainAndRelated: an Opportunity', () => {
  it('reads its Account, then the contact roles, then each Contact', async () => {
    const sf = fakeSalesforce({
      describes,
      queries: [
        [/FROM Opportunity WHERE Id = /, [{ Id: OPP, Name: 'Oak St', AccountId: ACCOUNT }]],
        [/FROM OpportunityContactRole/, [{ ContactId: CONTACT, Role: 'Decision Maker', IsPrimary: true }, { ContactId: CONTACT2, Role: null, IsPrimary: false }]],
        [/FROM Account WHERE Id = /, [{ Id: ACCOUNT, Name: 'Family' }]],
        [new RegExp(`FROM Contact WHERE Id = '${CONTACT}'`), [{ Id: CONTACT, Name: 'Pat' }]],
        [new RegExp(`FROM Contact WHERE Id = '${CONTACT2}'`), [{ Id: CONTACT2, Name: 'Sam' }]],
      ],
    });
    const got = await readMainAndRelated(deps(sf), { sfObject: 'Opportunity', sfRecordId: OPP, consentField: null });
    expect(sf.soql[1]).toBe(`SELECT ContactId, Role, IsPrimary FROM OpportunityContactRole WHERE OpportunityId = '${OPP}' ORDER BY IsPrimary DESC LIMIT 6`);
    expect(got?.related.items.map((b) => [b.relation, b.id, b.role])).toEqual([
      ['account', ACCOUNT, null],
      ['contact', CONTACT, 'Decision Maker'],
      ['contact', CONTACT2, null],
    ]);
    expect(got?.links).toEqual({ whoIds: [CONTACT, CONTACT2], whatIds: [OPP, ACCOUNT], parentIds: [OPP, CONTACT, CONTACT2, ACCOUNT] });
  });
});

describe('consent', () => {
  const read = async (row: Record<string, unknown>, consentField: string | null, sobject: 'Lead' | 'Opportunity' = 'Lead') => {
    const sf = fakeSalesforce({ describes, queries: [[/FROM (Lead|Opportunity) WHERE Id = /, [row]], [/FROM OpportunityContactRole/, []]] });
    return (await readMainAndRelated(deps(sf), { sfObject: sobject, sfRecordId: sobject === 'Lead' ? LEAD : OPP, consentField }))?.consent;
  };
  it.each([
    [{ AI_Call_Consent__c: true }, 'AI_Call_Consent__c', 'yes'],
    [{ AI_Call_Consent__c: false }, 'AI_Call_Consent__c', 'no'],
    [{ AI_Call_Consent__c: null }, 'AI_Call_Consent__c', 'no'],
    [{ AI_Call_Consent__c: true }, 'ai_call_consent__c', 'yes'],
    [{ AI_Call_Consent__c: true }, 'Missing_Field__c', 'field_missing'],
    [{ AI_Call_Consent__c: true }, null, 'field_missing'],
  ])('%j with field %s -> %s', async (row, field, expected) => {
    expect(await read({ Id: LEAD, ...row }, field)).toBe(expected);
  });
  it('configured but absent from the row: unknown, never no', async () => {
    expect(await read({ Id: LEAD }, 'AI_Call_Consent__c')).toBe('unknown');
  });
  it('a value that is neither a boolean nor null is unknown, never no', async () => {
    expect(await read({ Id: LEAD, AI_Call_Consent__c: 'true' }, 'AI_Call_Consent__c')).toBe('unknown');
  });

  describe('a consent field behind a long field list', () => {
    const many = Array.from({ length: 400 }, (_, i): [string] => [`A_Rather_Long_Custom_Field_Name_Number_${i}__c`]);
    const wide = { ...describes, Lead: describeOf('Lead', [['Id', 'id'], ...many, ['AI_Call_Consent__c', 'boolean']]) };
    const wideRead = async (value: unknown) => {
      const sf = fakeSalesforce({ describes: wide, queries: [[/FROM Lead WHERE Id = /, [{ Id: LEAD, AI_Call_Consent__c: value }]]] });
      const got = await readMainAndRelated(deps(sf), { sfObject: 'Lead', sfRecordId: LEAD, consentField: 'AI_Call_Consent__c' });
      return { sf, got };
    };
    it('is always selected, right after Id, so yes stays yes', async () => {
      const { sf, got } = await wideRead(true);
      expect(sf.soql[0]).toMatch(/^SELECT Id, AI_Call_Consent__c, A_Rather_Long_Custom_Field_Name_Number_0__c, /);
      expect(sf.soql[0]!.length).toBeLessThan(7_000);
      expect(got?.consent).toBe('yes');
    });
    it('and an explicit no stays no', async () => {
      expect((await wideRead(false)).got?.consent).toBe('no');
    });
    it('is matched case-insensitively against the describe and selected under its describe name', async () => {
      const sf = fakeSalesforce({ describes: wide, queries: [[/FROM Lead WHERE Id = /, [{ Id: LEAD, AI_Call_Consent__c: true }]]] });
      const got = await readMainAndRelated(deps(sf), { sfObject: 'Lead', sfRecordId: LEAD, consentField: 'ai_call_consent__c' });
      expect(sf.soql[0]).toMatch(/^SELECT Id, AI_Call_Consent__c, /);
      expect(got?.consent).toBe('yes');
    });
  });

  it('is field_missing when the describe lacks the field', async () => {
    const sf = fakeSalesforce({ describes: { ...describes, Lead: describeOf('Lead', [['Id', 'id'], ['Name']]) }, queries: [leadRoute({ Id: LEAD, Name: 'x' })] });
    expect((await readMainAndRelated(deps(sf), { sfObject: 'Lead', sfRecordId: LEAD, consentField: 'AI_Call_Consent__c' }))?.consent).toBe('field_missing');
  });
});

describe('Fix 1 (I-2): qualification fields behind a long field list', () => {
  const many = Array.from({ length: 400 }, (_, i): [string] => [`A_Rather_Long_Custom_Field_Name_Number_${i}__c`]);
  const wideLead = describeOf('Lead', [['Id', 'id'], ...many, ['Timeline__c', 'picklist'], ['AI_Call_Consent__c', 'boolean'], ['Seller_s_Asking_Price__c', 'currency'], ['Mold__c', 'boolean']]);

  it('are always selected, after Id and the consent field, and the block says which were read', async () => {
    const sf = fakeSalesforce({ describes: { ...describes, Lead: wideLead }, queries: [[/FROM Lead WHERE Id = /, [{ Id: LEAD, AI_Call_Consent__c: true, Timeline__c: '30 Days' }]]] });
    const got = await readMainAndRelated(deps(sf), { sfObject: 'Lead', sfRecordId: LEAD, consentField: 'AI_Call_Consent__c' });
    expect(sf.soql[0]).toMatch(/^SELECT Id, AI_Call_Consent__c, Timeline__c, Mold__c, Seller_s_Asking_Price__c, A_Rather_Long_Custom_Field_Name_Number_0__c, /);
    expect(sf.soql[0]!.length).toBeLessThan(7_000);
    expect(got?.main.fields).toContainEqual({ name: 'Timeline__c', label: 'Timeline__c label', value: '30 Days' });
    // In QUALIFICATION_FIELDS order; a field the describe lacks was never read.
    expect(got?.main.qualificationFieldsRead).toEqual(['Timeline__c', 'Mold__c', 'Seller_s_Asking_Price__c']);
  });

  it('an Opportunity pins its own names', async () => {
    const opp = describeOf('Opportunity', [['Id', 'id'], ...many, ['AccountId', 'reference'], ['SellersAskingPrice__c', 'currency'], ['Reason_For_Selling__c', 'textarea']]);
    const sf = fakeSalesforce({ describes: { ...describes, Opportunity: opp }, queries: [[/FROM Opportunity WHERE Id = /, [{ Id: OPP }]], [/FROM OpportunityContactRole/, []]] });
    const got = await readMainAndRelated(deps(sf), { sfObject: 'Opportunity', sfRecordId: OPP, consentField: null });
    expect(sf.soql[0]).toMatch(/^SELECT Id, Reason_For_Selling__c, SellersAskingPrice__c, A_Rather/);
    expect(got?.main.qualificationFieldsRead).toEqual(['Reason_For_Selling__c', 'SellersAskingPrice__c']);
  });
});

describe('field values', () => {
  it('leaves out false booleans and empty strings, and clips long values', async () => {
    const long = 'x'.repeat(1_500);
    const sf = fakeSalesforce({ describes, queries: [leadRoute(lead({ Notes__c: long, Phone: '', DoNotCall: false }))] });
    const got = await readMainAndRelated(deps(sf), { sfObject: 'Lead', sfRecordId: LEAD, consentField: null });
    const byName = Object.fromEntries((got?.main.fields ?? []).map((f) => [f.name, f.value]));
    expect(Object.keys(byName)).toEqual(['Name', 'AI_Call_Consent__c', 'Notes__c']);
    expect(byName.AI_Call_Consent__c).toBe('true');
    expect(byName.Notes__c).toHaveLength(1_001);
    expect(byName.Notes__c?.endsWith('…')).toBe(true);
  });

  it('keeps the SOQL select list short enough for a GET', async () => {
    const many = Array.from({ length: 300 }, (_, i): [string] => [`A_Rather_Long_Custom_Field_Name_Number_${i}__c`]);
    const sf = fakeSalesforce({ describes: { ...describes, Lead: describeOf('Lead', [['Id', 'id'], ...many]) }, queries: [[/FROM Lead/, [{ Id: LEAD }]]] });
    await readMainAndRelated(deps(sf), { sfObject: 'Lead', sfRecordId: LEAD, consentField: null });
    expect(sf.soql[0]!.length).toBeLessThan(7_000);
    expect(sf.soql[0]).toMatch(/^SELECT Id, A_Rather/);
  });
});

describe('degraded and failed reads', () => {
  const converted = lead({ IsConverted: true, ConvertedContactId: CONTACT, ConvertedAccountId: ACCOUNT });
  const denied = new SalesforceApiError('denied', 403, [{ errorCode: 'INSUFFICIENT_ACCESS', message: 'x' }]);

  it('every related read denied: the status stands, the main block is still returned', async () => {
    const sf = fakeSalesforce({ describes, queries: [leadRoute(converted), [/FROM Contact/, denied], [/FROM Account/, denied]] });
    const got = await readMainAndRelated(deps(sf), { sfObject: 'Lead', sfRecordId: LEAD, consentField: null });
    expect(got?.main.id).toBe(LEAD);
    expect(got?.related.summary).toMatchObject({ status: 'denied', count: 0, note: 'INSUFFICIENT_ACCESS' });
  });

  it('some related reads worked: status ok, the note names the failure', async () => {
    const sf = fakeSalesforce({ describes, queries: [leadRoute(converted), [/FROM Contact/, denied], [/FROM Account/, [{ Id: ACCOUNT, Name: 'A' }]]] });
    const got = await readMainAndRelated(deps(sf), { sfObject: 'Lead', sfRecordId: LEAD, consentField: null });
    expect(got?.related.summary).toMatchObject({ status: 'ok', count: 1, note: 'INSUFFICIENT_ACCESS' });
  });

  it('M-3: an Opportunity whose contact roles cannot be read still gets its Account; the note names the failure', async () => {
    const sf = fakeSalesforce({
      describes,
      queries: [
        [/FROM Opportunity WHERE Id = /, [{ Id: OPP, Name: 'Oak St', AccountId: ACCOUNT }]],
        [/FROM OpportunityContactRole/, denied],
        [/FROM Account WHERE Id = /, [{ Id: ACCOUNT, Name: 'Family' }]],
      ],
    });
    const got = await readMainAndRelated(deps(sf), { sfObject: 'Opportunity', sfRecordId: OPP, consentField: null });
    expect(got?.related.items.map((b) => [b.relation, b.id])).toEqual([['account', ACCOUNT]]);
    expect(got?.related.summary).toMatchObject({ status: 'ok', count: 1, note: 'INSUFFICIENT_ACCESS' });
    expect(got?.links.whatIds).toEqual([OPP, ACCOUNT]);
  });

  it('M-2: a MALFORMED_QUERY on an optional read is that source missing, never a failed research', async () => {
    const malformed = new SalesforceApiError('bad', 400, [{ errorCode: 'MALFORMED_QUERY', message: 'x' }]);
    const sf = fakeSalesforce({ describes, queries: [leadRoute(converted), [/FROM Contact/, malformed], [/FROM Account/, malformed]] });
    const got = await readMainAndRelated(deps(sf), { sfObject: 'Lead', sfRecordId: LEAD, consentField: null });
    expect(got?.related.summary).toMatchObject({ status: 'missing', count: 0, note: 'MALFORMED_QUERY' });
  });

  it('a 503 on the main read throws', async () => {
    const sf = fakeSalesforce({ describes, queries: [[/FROM Lead/, new SalesforceApiError('down', 503, null)]] });
    await expect(readMainAndRelated(deps(sf), { sfObject: 'Lead', sfRecordId: LEAD, consentField: null })).rejects.toThrow('down');
  });

  it('a 503 on a related read throws: no plan from half the data', async () => {
    const sf = fakeSalesforce({ describes, queries: [leadRoute(converted), [/FROM Contact/, new SalesforceApiError('down', 503, null)], [/FROM Account/, []]] });
    await expect(readMainAndRelated(deps(sf), { sfObject: 'Lead', sfRecordId: LEAD, consentField: null })).rejects.toThrow('down');
  });
});
