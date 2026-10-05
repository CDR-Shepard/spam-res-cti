import { describe, expect, it, vi } from 'vitest';
import { QueryTooLargeError, SalesforceApiError, type SalesforceClient } from '@cti/salesforce';
import { CampaignSourceError, fetchMemberIds, MAX_CAMPAIGN_RECORDS, membershipSoql, validateSoql } from './source.js';

describe('validateSoql', () => {
  it.each([
    ['upper-case keywords', "SELECT Id FROM Lead WHERE Status = 'Open'", 'Lead'],
    ['lower-case keywords', 'select id, name from lead where isconverted = false', 'Lead'],
    ['mixed-case object', 'SELECT Id FROM opportunity', 'Opportunity'],
    ['line breaks', 'SELECT Id\nFROM\n  Opportunity\nWHERE IsClosed = false', 'Opportunity'],
    ['a child subquery FROM inside parentheses', 'SELECT Id, (SELECT Id FROM OpportunityContactRoles) FROM Opportunity', 'Opportunity'],
    ['a semi-join subquery FROM inside parentheses', "SELECT Id FROM Lead WHERE Id IN (SELECT WhoId FROM Task WHERE Subject = 'Call')", 'Lead'],
    ['FROM and a paren inside a string literal', "SELECT Id FROM Lead WHERE Description = 'met at FROM Contact expo (2025'", 'Lead'],
    ['an escaped quote in a literal', "SELECT Id FROM Lead WHERE LastName = 'O\\'Brien'", 'Lead'],
    ['a list view describe query', "SELECT Name, Company, Id, CreatedDate FROM Lead USING SCOPE mine WHERE IsConverted = false ORDER BY Name ASC NULLS FIRST, Id ASC NULLS FIRST", 'Lead'],
  ])('accepts %s', (_label, soql, sfObject) => {
    expect(validateSoql(soql)).toEqual({ ok: true, sfObject });
  });

  it.each([
    ['FROM Contact', 'SELECT Id FROM Contact', /Lead or Opportunity, not Contact/],
    ['a look-alike object', 'SELECT Id FROM LeadHistory', /not LeadHistory/],
    ['COUNT()', 'SELECT COUNT() FROM Lead', /Aggregate/],
    ['COUNT(Id) with GROUP BY', 'SELECT LeadSource, COUNT(Id) FROM Lead GROUP BY LeadSource', /Aggregate/],
    ['GROUP BY', 'SELECT Status FROM Lead GROUP BY Status', /Aggregate/],
    ['lower-case group by', 'select status from lead group by status', /Aggregate/],
    ['MAX()', 'SELECT MAX(Amount) FROM Opportunity', /Aggregate/],
    ['a semicolon', 'SELECT Id FROM Lead; SELECT Id FROM Contact', /semicolon/],
    ['FOR UPDATE', 'SELECT Id FROM Lead FOR UPDATE', /FOR UPDATE/],
    ['FOR VIEW (it writes LastViewedDate)', 'SELECT Id FROM Lead FOR VIEW', /FOR UPDATE, FOR VIEW/],
    ['a non-SELECT statement', 'Id FROM Lead', /start with SELECT/],
    ['unbalanced parentheses', 'SELECT Id FROM Lead WHERE Id IN (SELECT WhoId FROM Task', /parentheses/],
    ['FROM only inside a subquery', 'SELECT Id, (SELECT Id FROM Lead)', /no FROM/],
  ])('rejects %s', (_label, soql, reason) => {
    const result = validateSoql(soql);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });
});

function stubClient(over: Partial<Record<'listViewSoql' | 'queryAll', ReturnType<typeof vi.fn>>> = {}) {
  const client = { listViewSoql: vi.fn(), queryAll: vi.fn(), ...over };
  return { client, sf: client as unknown as SalesforceClient };
}

describe('membershipSoql', () => {
  it('returns pasted SOQL trimmed, after validation', async () => {
    const { sf } = stubClient();
    await expect(membershipSoql(sf, { sfObject: 'Lead', source: { kind: 'soql', soql: '  SELECT Id FROM Lead  ' } })).resolves.toBe('SELECT Id FROM Lead');
  });

  it.each([
    ['invalid SOQL', { kind: 'soql', soql: 'SELECT COUNT() FROM Lead' }, 'Lead', 'invalid_soql'],
    ['an object that does not match the campaign', { kind: 'soql', soql: 'SELECT Id FROM Opportunity' }, 'Lead', 'object_mismatch'],
    ['a malformed list view id', { kind: 'list_view', listViewId: '00B5f00000ABC$%' }, 'Lead', 'invalid_soql'],
  ] as const)('throws CampaignSourceError for %s', async (_label, source, sfObject, code) => {
    const { client, sf } = stubClient();
    const err = await membershipSoql(sf, { sfObject, source }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CampaignSourceError);
    expect((err as CampaignSourceError).code).toBe(code);
    expect(client.listViewSoql).not.toHaveBeenCalled();
  });

  it("turns a list view into its described SOQL, and checks that SOQL's object", async () => {
    const { client, sf } = stubClient({ listViewSoql: vi.fn(async () => 'SELECT Id, Name FROM Lead WHERE IsConverted = false') });
    await expect(membershipSoql(sf, { sfObject: 'Lead', source: { kind: 'list_view', listViewId: '00B5f00000ABCDE' } })).resolves.toBe('SELECT Id, Name FROM Lead WHERE IsConverted = false');
    expect(client.listViewSoql).toHaveBeenCalledWith('Lead', '00B5f00000ABCDE');
    const mismatch = stubClient({ listViewSoql: vi.fn(async () => 'SELECT Id FROM Opportunity') });
    await expect(membershipSoql(mismatch.sf, { sfObject: 'Lead', source: { kind: 'list_view', listViewId: '00B5f00000ABCDE' } })).rejects.toMatchObject({ code: 'object_mismatch' });
  });

  it("reports Salesforce's own error when the list view cannot be described", async () => {
    const { sf } = stubClient({ listViewSoql: vi.fn(async () => { throw new SalesforceApiError('describe failed (404)', 404, [{ errorCode: 'NOT_FOUND', message: 'The requested resource does not exist' }]); }) });
    await expect(membershipSoql(sf, { sfObject: 'Lead', source: { kind: 'list_view', listViewId: '00B5f00000ABCDE' } }))
      .rejects.toMatchObject({ code: 'salesforce_error', message: expect.stringContaining('NOT_FOUND: The requested resource does not exist') });
  });
});

describe('fetchMemberIds', () => {
  it('reads every Id (from attributes.url when Id is not selected), de-duplicated, in query order, with the cap passed through', async () => {
    const rows = [
      { Id: '00Q000000000001AAA' },
      { attributes: { type: 'Lead', url: '/services/data/v60.0/sobjects/Lead/00Q000000000002AAA' }, Name: 'B' },
      { Id: '00Q000000000001AAA' },
      { attributes: { type: 'Lead' } },
      { Id: '00Q000000000003AAA' },
    ];
    const { client, sf } = stubClient({ queryAll: vi.fn(async () => rows) });
    await expect(fetchMemberIds(sf, 'SELECT Name FROM Lead')).resolves.toEqual(['00Q000000000001AAA', '00Q000000000002AAA', '00Q000000000003AAA']);
    expect(client.queryAll).toHaveBeenCalledWith('SELECT Name FROM Lead', { maxRecords: MAX_CAMPAIGN_RECORDS });
  });

  it('maps a too-large result to too_large ("narrow the query")', async () => {
    const { sf } = stubClient({ queryAll: vi.fn(async () => { throw new QueryTooLargeError(50_000); }) });
    await expect(fetchMemberIds(sf, 'SELECT Id FROM Lead')).rejects.toMatchObject({ code: 'too_large', message: expect.stringMatching(/50,000.*Narrow the query/) });
  });

  it("maps a Salesforce query error to salesforce_error with Salesforce's words", async () => {
    const { sf } = stubClient({ queryAll: vi.fn(async () => { throw new SalesforceApiError('query failed (400)', 400, [{ errorCode: 'INVALID_FIELD', message: "No such column 'Foo__c' on entity 'Lead'" }]); }) });
    await expect(fetchMemberIds(sf, 'SELECT Foo__c FROM Lead')).rejects.toMatchObject({ code: 'salesforce_error', message: "INVALID_FIELD: No such column 'Foo__c' on entity 'Lead'" });
  });
});
