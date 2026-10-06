/** Task 24: a Lead that booked is converted like the team converts, exactly once; what the lead mapping drops is carried. */
import { describe, expect, it } from 'vitest';
import { SalesforceApiError, SalesforceAuthError } from '@cti/salesforce';
import { convertOk, convertRefused, fakeSfWrites, soapFaultAnswer, userInfoAnswer, type WriteQueryRoute } from '../test/fake-sf-writes.js';
import { CARRY_FIELDS, carryPatch, convertedStatus, convertStep, leadManagerFor } from './convert.js';

const LEAD = '00Q8X00000AbCdEUAV';
const GRANT = '0058X00000Fsx39QAB';
const SETTER = '0058X00000Setr1QAA';
const US = '0058X0000Integ1QAA';
const OPP = '0068X00000Oppt1QAA';
const ACCOUNT = '0018X00000Acct1QAA';
const CONTACT = '0038X00000Cont1QAA';
const ENDED = new Date('2026-10-06T22:12:00.000Z');

const LEAD_ROW = {
  Id: LEAD,
  Name: 'Jane Seller',
  OwnerId: SETTER,
  IsConverted: false,
  ConvertedOpportunityId: null,
  ConvertedAccountId: null,
  ConvertedContactId: null,
  AI_Call_Consent__c: true,
  AI_Call_Consent_Date__c: '2026-09-30',
  AI_Call_Consent_Source__c: 'Web Form',
  Spanish_Speaker__c: false,
  Skip_on_Dialer__c: false,
};
const STATUS = /^SELECT MasterLabel, SortOrder FROM LeadStatus WHERE IsConverted = true/;
const READ_LEAD = /^SELECT Id, Name, OwnerId, IsConverted, .* FROM Lead WHERE Id = /;
const READ_OPP = /^SELECT Id, CreatedById, CreatedDate FROM Opportunity WHERE Id = /;

function org(lead: Record<string, unknown> | null = LEAD_ROW, more: WriteQueryRoute[] = []) {
  return fakeSfWrites({ queries: [...more, [READ_LEAD, lead ? [lead] : []], [STATUS, [{ MasterLabel: 'Qualified', SortOrder: 6 }]]] });
}
const step = (f: ReturnType<typeof org>) => convertStep(f.client, { leadId: LEAD, ownerId: GRANT, callEndedAt: ENDED });
const converts = (f: ReturnType<typeof org>) => f.soapBodies.filter((b) => b.includes('convertLead'));

describe('convertStep', () => {
  it('1: an unconverted Lead: one convertLead like the team\'s (Qualified, owner Grant, named after the Lead, new Account and Contact, no email)', async () => {
    const f = org();
    f.onSoap = () => convertOk({ leadId: LEAD, accountId: ACCOUNT, contactId: CONTACT, opportunityId: OPP });
    const { outcome, lead } = await step(f);
    expect(outcome).toEqual({ kind: 'converted', opportunityId: OPP, accountId: ACCOUNT, contactId: CONTACT, adopted: false });
    expect(lead).toMatchObject({ Name: 'Jane Seller', OwnerId: SETTER, AI_Call_Consent__c: true });
    expect(f.soql[0]).toBe(
      `SELECT Id, Name, OwnerId, IsConverted, ConvertedOpportunityId, ConvertedAccountId, ConvertedContactId, AI_Call_Consent__c, AI_Call_Consent_Date__c, AI_Call_Consent_Source__c, Spanish_Speaker__c, Skip_on_Dialer__c FROM Lead WHERE Id = '${LEAD}' LIMIT 1`,
    );
    expect(f.soapBodies).toHaveLength(1);
    const body = f.soapBodies[0]!;
    expect(body).toContain('<urn:convertedStatus>Qualified</urn:convertedStatus>');
    expect(body).toContain(`<urn:ownerId>${GRANT}</urn:ownerId>`);
    expect(body).toContain('<urn:opportunityName>Jane Seller</urn:opportunityName>');
    expect(body).toContain('<urn:sendNotificationEmail>false</urn:sendNotificationEmail>');
    expect(body).toContain('<urn:doNotCreateOpportunity>false</urn:doNotCreateOpportunity>');
    expect(body).not.toContain('accountId');
    expect(body).not.toContain('contactId');
  });

  it('only the carry fields the Lead describe has are read', async () => {
    const f = org();
    f.onSoap = () => convertOk({ leadId: LEAD, accountId: ACCOUNT, contactId: CONTACT, opportunityId: OPP });
    const describe = { name: 'Lead', fields: ['Id', 'Name', 'AI_Call_Consent__c', 'Skip_on_Dialer__c'].map((name) => ({ name, type: 'string', label: name })) };
    await convertStep(f.client, { leadId: LEAD, ownerId: GRANT, callEndedAt: ENDED, leadDescribe: describe });
    expect(f.soql[0]).toContain('ConvertedContactId, AI_Call_Consent__c, Skip_on_Dialer__c FROM Lead');
  });

  const converted = { ...LEAD_ROW, IsConverted: true, ConvertedOpportunityId: OPP, ConvertedAccountId: ACCOUNT, ConvertedContactId: CONTACT };

  it('2: already converted, the Opportunity made by us after the call (a lost answer): adopted, ours; never converted again', async () => {
    const f = org(converted, [[READ_OPP, [{ Id: OPP, CreatedById: US, CreatedDate: '2026-10-06T22:15:00.000+0000' }]]]);
    f.onSoap = (b) => (b.includes('getUserInfo') ? userInfoAnswer(US) : new Error('no convert'));
    const { outcome } = await step(f);
    expect(outcome).toEqual({ kind: 'adopted', opportunityId: OPP, accountId: ACCOUNT, contactId: CONTACT, adopted: true, ours: true });
    expect(converts(f)).toEqual([]);
  });

  it('3: already converted by a rep: adopted, not ours; never converted again', async () => {
    const f = org(converted, [[READ_OPP, [{ Id: OPP, CreatedById: SETTER, CreatedDate: '2026-10-06T22:20:00.000+0000' }]]]);
    f.onSoap = (b) => (b.includes('getUserInfo') ? userInfoAnswer(US) : new Error('no convert'));
    expect((await step(f)).outcome).toMatchObject({ kind: 'adopted', ours: false });
    // Made before the call ended: not ours, whoever made it (no SOAP needed to tell).
    const early = org(converted, [[READ_OPP, [{ Id: OPP, CreatedById: US, CreatedDate: '2026-10-06T21:00:00.000+0000' }]]]);
    expect((await step(early)).outcome).toMatchObject({ kind: 'adopted', ours: false });
    expect(early.soapBodies).toEqual([]);
    expect(converts(f)).toEqual([]);
  });

  it('adopting while SOAP is closed to this connection (a permanent fault): not ours, since the AI converts only over SOAP', async () => {
    const f = org(converted, [[READ_OPP, [{ Id: OPP, CreatedById: US, CreatedDate: '2026-10-06T22:15:00.000+0000' }]]]);
    f.onSoap = () => soapFaultAnswer('API_DISABLED_FOR_ORG', 'API is not enabled');
    expect((await step(f)).outcome).toMatchObject({ kind: 'adopted', ours: false });
    const t = org(converted, [[READ_OPP, [{ Id: OPP, CreatedById: US, CreatedDate: '2026-10-06T22:15:00.000+0000' }]]]);
    t.onSoap = () => soapFaultAnswer('UNKNOWN_EXCEPTION');
    await expect(step(t)).rejects.toMatchObject({ code: 'UNKNOWN_EXCEPTION' });
  });

  it('4: converted without an Opportunity: no_opportunity with the Account', async () => {
    const f = org({ ...converted, ConvertedOpportunityId: null });
    expect((await step(f)).outcome).toEqual({ kind: 'no_opportunity', accountId: ACCOUNT });
    expect(f.soapBodies).toEqual([]);
  });

  it.each(['INSUFFICIENT_ACCESS', 'API_DISABLED_FOR_ORG', 'API_CURRENTLY_DISABLED'])('4b: a %s fault is permanent: refused (fallback), never thrown', async (code) => {
    const f = org();
    f.onSoap = () => soapFaultAnswer(code, 'no access');
    expect((await step(f)).outcome).toEqual({ kind: 'refused', code, message: expect.stringContaining('no access') });
  });

  it('5: success false with FIELD_CUSTOM_VALIDATION_EXCEPTION (the Hunt rule): refused with code and message', async () => {
    const f = org();
    f.onSoap = () => convertRefused('FIELD_CUSTOM_VALIDATION_EXCEPTION', 'Only the Hunt winner may convert');
    expect((await step(f)).outcome).toEqual({ kind: 'refused', code: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Only the Hunt winner may convert' });
  });

  it('D-5: UNABLE_TO_LOCK_ROW or REQUEST_LIMIT_EXCEEDED in the result is transient: it throws (retried)', async () => {
    for (const code of ['UNABLE_TO_LOCK_ROW', 'REQUEST_LIMIT_EXCEEDED']) {
      const f = org();
      f.onSoap = () => convertRefused(code, 'busy');
      await expect(step(f)).rejects.toMatchObject({ name: 'SalesforceApiError', code });
    }
  });

  it('6: a SOAP fault UNKNOWN_EXCEPTION, or a transport error, throws (retried by the tick)', async () => {
    const f = org();
    f.onSoap = () => soapFaultAnswer('UNKNOWN_EXCEPTION');
    await expect(step(f)).rejects.toMatchObject({ code: 'UNKNOWN_EXCEPTION' });
    const t = org();
    t.onSoap = () => new SalesforceApiError('Salesforce SOAP request failed: TypeError', 0, null);
    await expect(step(t)).rejects.toBeInstanceOf(SalesforceApiError);
  });

  it('a second INVALID_SESSION_ID while REST works for the token: refused SOAP_UNAVAILABLE; when REST fails too it throws', async () => {
    const f = org();
    f.onSoap = () => new SalesforceAuthError('Salesforce rejected the refreshed access token (SOAP INVALID_SESSION_ID)');
    expect((await step(f)).outcome).toMatchObject({ kind: 'refused', code: 'SOAP_UNAVAILABLE' });

    let reads = 0;
    const g = org(null, [[READ_LEAD, () => (++reads === 1 ? [LEAD_ROW] : new SalesforceAuthError())]]);
    g.onSoap = () => new SalesforceAuthError();
    await expect(step(g)).rejects.toBeInstanceOf(SalesforceAuthError);
  });

  it('D-5: an unreadable answer re-reads the Lead: converted after all → adopted; still not → refused MALFORMED_RESPONSE', async () => {
    let reads = 0;
    const f = org(null, [
      [READ_LEAD, () => [++reads === 1 ? LEAD_ROW : converted]],
      [READ_OPP, [{ Id: OPP, CreatedById: US, CreatedDate: '2026-10-06T22:15:00.000+0000' }]],
    ]);
    f.onSoap = (b) => (b.includes('getUserInfo') ? userInfoAnswer(US) : { status: 200, xml: '<soapenv:Envelope><soapenv:Body/></soapenv:Envelope>' });
    expect((await step(f)).outcome).toMatchObject({ kind: 'adopted', ours: true });

    const g = org();
    g.onSoap = () => ({ status: 200, xml: '<garbage/>' });
    expect((await step(g)).outcome).toMatchObject({ kind: 'refused', code: 'MALFORMED_RESPONSE' });
  });

  it('7: the Lead row is missing: gone', async () => {
    const f = org(null);
    expect(await step(f)).toEqual({ outcome: { kind: 'gone' }, lead: null });
    expect(f.soapBodies).toEqual([]);
  });

  it('a Lead name over 120 characters is cut for the Opportunity name', async () => {
    const f = org({ ...LEAD_ROW, Name: 'N'.repeat(150) });
    f.onSoap = () => convertOk({ leadId: LEAD, accountId: ACCOUNT, contactId: CONTACT, opportunityId: OPP });
    await step(f);
    expect(f.soapBodies[0]).toContain(`<urn:opportunityName>${'N'.repeat(120)}</urn:opportunityName>`);
  });
});

describe('convertedStatus', () => {
  it('8: two converted LeadStatus rows (Converted, Qualified): Qualified', async () => {
    const f = fakeSfWrites({ queries: [[STATUS, [{ MasterLabel: 'Converted', SortOrder: 5 }, { MasterLabel: 'Qualified', SortOrder: 6 }]]] });
    expect(await convertedStatus(f.client)).toBe('Qualified');
    expect(f.soql[0]).toBe('SELECT MasterLabel, SortOrder FROM LeadStatus WHERE IsConverted = true ORDER BY SortOrder');
  });

  it('no Qualified: the first by SortOrder; none at all: throws', async () => {
    const f = fakeSfWrites({ queries: [[STATUS, [{ MasterLabel: 'Closed - Converted', SortOrder: 3 }, { MasterLabel: 'Won', SortOrder: 9 }]]] });
    expect(await convertedStatus(f.client)).toBe('Closed - Converted');
    await expect(convertedStatus(fakeSfWrites({ queries: [[STATUS, []]] }).client)).rejects.toThrow(/converted LeadStatus/);
  });
});

describe('carryPatch', () => {
  const updateable = new Set([...CARRY_FIELDS, 'LeadManager__c']);
  const blankOpp = { Id: OPP, AI_Call_Consent__c: false, AI_Call_Consent_Date__c: null, AI_Call_Consent_Source__c: null, Spanish_Speaker__c: false, Skip_on_Dialer__c: false };

  it('9: consent yes + date + source onto a blank Opportunity: all three copied exactly; the Lead Manager set', () => {
    expect(carryPatch({ lead: LEAD_ROW, opp: blankOpp, updateable, leadManager: SETTER })).toEqual({
      AI_Call_Consent__c: true,
      AI_Call_Consent_Date__c: '2026-09-30',
      AI_Call_Consent_Source__c: 'Web Form',
      LeadManager__c: SETTER,
    });
  });

  it('10: a consent value of unknown is copied as unknown (never upgraded)', () => {
    const lead = { ...LEAD_ROW, AI_Call_Consent__c: 'unknown', AI_Call_Consent_Date__c: null, AI_Call_Consent_Source__c: null };
    expect(carryPatch({ lead, opp: { ...blankOpp, AI_Call_Consent__c: null }, updateable, leadManager: null })).toEqual({ AI_Call_Consent__c: 'unknown' });
  });

  it('11: an Opportunity value is never overwritten', () => {
    const opp = { ...blankOpp, AI_Call_Consent_Source__c: 'Rep', Spanish_Speaker__c: true };
    const lead = { ...LEAD_ROW, Spanish_Speaker__c: true };
    expect(carryPatch({ lead, opp, updateable, leadManager: null })).toEqual({ AI_Call_Consent__c: true, AI_Call_Consent_Date__c: '2026-09-30' });
  });

  it('12: a field the connected user cannot update is left out (case-insensitive; written in the org\'s spelling)', () => {
    const lead = { ...LEAD_ROW, Spanish_Speaker__c: true, Skip_on_Dialer__c: true };
    const some = new Set(['ai_call_consent__C', 'Skip_on_Dialer__c']);
    expect(carryPatch({ lead, opp: blankOpp, updateable: some, leadManager: SETTER })).toEqual({ ai_call_consent__C: true, Skip_on_Dialer__c: true });
  });

  it('an empty patch is empty', () => {
    expect(carryPatch({ lead: { ...LEAD_ROW, AI_Call_Consent__c: false, AI_Call_Consent_Date__c: null, AI_Call_Consent_Source__c: '' }, opp: blankOpp, updateable, leadManager: null })).toEqual({});
  });
});

describe('leadManagerFor', () => {
  const users = (rows: Record<string, unknown>[]) => fakeSfWrites({ queries: [[/^SELECT Id, IsActive FROM User WHERE Id = /, rows]] });

  it('13: an active user owner → the owner; a queue owner → Grant; an inactive user → Grant', async () => {
    const active = users([{ Id: SETTER, IsActive: true }]);
    expect(await leadManagerFor(active.client, SETTER, GRANT)).toBe(SETTER);
    expect(active.soql[0]).toBe(`SELECT Id, IsActive FROM User WHERE Id = '${SETTER}' LIMIT 1`);

    const queue = users([]);
    expect(await leadManagerFor(queue.client, '00G8X00000Queu1QAA', GRANT)).toBe(GRANT);
    expect(queue.soql).toEqual([]);

    expect(await leadManagerFor(users([{ Id: SETTER, IsActive: false }]).client, SETTER, GRANT)).toBe(GRANT);
    expect(await leadManagerFor(users([]).client, null, GRANT)).toBe(GRANT);
  });
});
