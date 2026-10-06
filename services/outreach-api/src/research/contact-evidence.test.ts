import { SalesforceApiError } from '@cti/salesforce';
import { describe, expect, it } from 'vitest';
import { fakeSalesforce } from '../test/fake-sf-client.js';
import { readContactEvidence } from './contact-evidence.js';
import type { LinkIds } from './related.js';

const LEAD = '00Q000000000001AAA';
const OPP = '006000000000001AAA';
const NOW = new Date('2026-10-05T19:00:00.000Z');
const links: LinkIds = { whoIds: [LEAD], whatIds: [OPP], parentIds: [LEAD, OPP] };

describe('readContactEvidence (final review OUT I-1)', () => {
  it('reads connected-call Tasks and past meeting Events through queryAll (archived too, never deleted), newest first, a few each', async () => {
    const sf = fakeSalesforce({
      archived: [
        [/FROM Task/, [{ Id: '00T000000000001AAA', Subject: 'Outbound Call | Connected | Pat', Status: 'Completed', ActivityDate: '2025-08-20', CreatedDate: '2025-08-20T17:00:00.000+0000', CallDisposition: 'Connected', TaskSubtype: 'Call', CallType: 'Outbound', CallDurationInSeconds: 300 }]],
        [/FROM Event/, [{ Id: '00U000000000001AAA', Subject: 'Property Consultation', StartDateTime: '2025-06-01T18:00:00.000+0000', EndDateTime: '2025-06-01T19:00:00.000+0000', CreatedDate: '2025-05-30T18:00:00.000+0000' }]],
      ],
    });
    const items = await readContactEvidence(sf.client, links, NOW);
    expect(sf.soql).toEqual([]);
    expect(sf.archived).toHaveLength(2);
    const [tasks, events] = sf.archived;
    const who = `(WhoId IN ('${LEAD}') OR WhatId IN ('${OPP}'))`;
    expect(tasks).toBe(
      `SELECT Id, Subject, Status, ActivityDate, CreatedDate, CallDisposition, TaskSubtype, CallType, CallDurationInSeconds FROM Task WHERE ${who} AND IsDeleted = false AND (` +
        "CallDisposition IN ('Connected', 'Do not call') OR (CallDisposition = 'Call back' AND CallDurationInSeconds >= 60) OR " +
        "(CallDisposition = null AND CallDurationInSeconds >= 60 AND CallType != 'Inbound' AND (NOT Subject LIKE 'Inbound Call%') AND ((NOT Subject LIKE 'CallRail Recording%') OR CallType = 'Outbound')) OR " +
        "Subject LIKE '%| Connected |%' OR Subject LIKE '%| Do not call |%' OR (Subject LIKE '%| Call back |%' AND CallDurationInSeconds >= 60)" +
        ') ORDER BY CreatedDate DESC LIMIT 10',
    );
    expect(events).toBe(
      `SELECT Id, Subject, StartDateTime, EndDateTime, CreatedDate FROM Event WHERE ${who} AND IsDeleted = false AND StartDateTime < 2026-10-05T19:00:00Z AND ` +
        "(Subject LIKE '%consult%' OR Subject LIKE '%appointment%' OR Subject LIKE '%walk%' OR Subject LIKE '%meeting%' OR Subject LIKE '%visit%') ORDER BY StartDateTime DESC LIMIT 5",
    );
    expect(items).toEqual([
      { source: 'task', id: '00T000000000001AAA', at: '2025-08-20T17:00:00.000+0000', title: 'Outbound Call | Connected | Pat', body: '', meta: { status: 'Completed', due: '2025-08-20', disposition: 'Connected', kind: 'Call', callType: 'Outbound', seconds: '300' } },
      { source: 'event', id: '00U000000000001AAA', at: '2025-05-30T18:00:00.000+0000', title: 'Property Consultation', body: '', meta: { starts: '2025-06-01T18:00:00.000+0000', ends: '2025-06-01T19:00:00.000+0000' } },
    ]);
  });

  it('only escaped, valid ids reach the SOQL; no ids → no read', async () => {
    const sf = fakeSalesforce({});
    expect(await readContactEvidence(sf.client, { whoIds: ["00Q000000000001AAA' OR Id != '"], whatIds: [], parentIds: [] }, NOW)).toEqual([]);
    expect(sf.archived).toEqual([]);
  });

  it('call fields the integration user cannot read (INVALID_FIELD): no Task evidence, the meetings are still read', async () => {
    const sf = fakeSalesforce({
      archived: [
        [/FROM Task/, new SalesforceApiError('x', 400, [{ errorCode: 'INVALID_FIELD', message: "No such column 'CallDisposition'" }])],
        [/FROM Event/, [{ Id: '00U000000000001AAA', Subject: 'Walkthrough', StartDateTime: '2026-06-01T18:00:00.000+0000', CreatedDate: '2026-05-30T18:00:00.000+0000' }]],
      ],
    });
    expect((await readContactEvidence(sf.client, links, NOW)).map((i) => i.source)).toEqual(['event']);
  });

  it('a refusal is no evidence; an outage propagates so research is retried', async () => {
    const denied = fakeSalesforce({ archived: [[/FROM/, new SalesforceApiError('x', 403, [{ errorCode: 'INSUFFICIENT_ACCESS', message: 'no' }])]] });
    expect(await readContactEvidence(denied.client, links, NOW)).toEqual([]);
    const down = fakeSalesforce({ archived: [[/FROM Task/, new SalesforceApiError('down', 503, null)]] });
    await expect(readContactEvidence(down.client, links, NOW)).rejects.toThrow('down');
  });
});
