/**
 * Test a record (plan 1E) tests: a Salesforce org that answers research's reads for one Lead and one Opportunity and the
 * appointment offer's User and Event reads, wrapped so a test can prove the client was only ever read (G-1).
 */
import type { FieldMap } from '@cti/contracts';
import type { SalesforceClient } from '@cti/salesforce';
import { describeOf, fakeSalesforce } from './fake-sf-client.js';
import { TEST_FIELD_MAP } from './outreach-fixtures.js';
import { GRANT } from './writeback-harness.js';

type Row = Record<string, unknown>;

export const RT_CONSENT = 'AI_Call_Consent__c';
/** 18-character Ids with valid checksums (contracts parseSalesforceRecordRef accepts them). */
export const RT_LEAD = '00Q8X00001AbCdEUAV';
export const RT_OPP = '0068X00000AbCdEQAV';
export const RT_FIELD_MAP: FieldMap = {
  Lead: { ...TEST_FIELD_MAP.Lead, consent: RT_CONSENT },
  Opportunity: { ...TEST_FIELD_MAP.Opportunity, consent: RT_CONSENT },
};
/** A connected call in February, found by research's archived contact read. */
export const FEBRUARY_CALL: Row = {
  Id: '00T000000000999AAA', Subject: 'Outbound Call | Connected | Pat', CreatedDate: '2026-02-12T18:00:00.000Z',
  CallDisposition: 'Connected', TaskSubtype: 'Call', CallType: 'Outbound',
};

/** Every method touched on the client (and each request's HTTP method), so a test can prove nothing was written. */
export function recording(client: SalesforceClient): { client: SalesforceClient; used: string[] } {
  const used: string[] = [];
  const proxy = new Proxy(client as unknown as Record<string | symbol, unknown>, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof prop === 'symbol' || prop === 'then') return value;
      if (typeof value !== 'function') {
        used.push(prop);
        return value;
      }
      return (...args: unknown[]) => {
        used.push(prop === 'request' ? `request ${(args[1] as { method?: string } | undefined)?.method ?? 'GET'}` : prop);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { client: proxy as unknown as SalesforceClient, used };
}

/** `lead` / `opp`: fields over the default row, or null when Salesforce does not return the record. */
export function recordTestOrg(o: { lead?: Row | null; opp?: Row | null; archived?: Row[] } = {}): { client: SalesforceClient; used: string[] } {
  const lead = o.lead === null ? [] : [{ Id: RT_LEAD, Name: 'Pat Seller', IsConverted: false, [RT_CONSENT]: true, ...o.lead }];
  const opp = o.opp === null ? [] : [{ Id: RT_OPP, Name: 'Oak Street', [RT_CONSENT]: false, ...o.opp }];
  const sf = fakeSalesforce({
    describes: {
      Lead: describeOf('Lead', [['Id', 'id'], ['Name'], ['IsConverted', 'boolean'], [RT_CONSENT, 'boolean']]),
      Opportunity: describeOf('Opportunity', [['Id', 'id'], ['Name'], [RT_CONSENT, 'boolean']]),
    },
    queries: [
      [/FROM Lead WHERE Id = /, lead],
      [/FROM Opportunity WHERE Id = /, opp],
      [/FROM OpportunityContactRole/, []],
      [/ FROM User /, [{ Id: GRANT, FirstName: 'Grant', Name: 'Grant Golden', IsActive: true, TimeZoneSidKey: 'America/Los_Angeles' }]],
      [/FROM Task/, []],
      [/FROM Event/, []],
      [/FROM Note/, []],
      [/FROM ContentDocumentLink/, []],
      [/FROM EmailMessage/, []],
      [/FROM FeedItem/, []],
    ],
    archived: [[/FROM Task/, o.archived ?? []]],
  });
  return recording(sf.client);
}
