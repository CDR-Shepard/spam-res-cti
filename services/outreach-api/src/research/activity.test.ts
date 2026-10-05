import { SalesforceApiError } from '@cti/salesforce';
import { describe, expect, it } from 'vitest';
import { fakeSalesforce } from '../test/fake-sf-client.js';
import { readContentNotes, readEmails, readEvents, readNotes, readTasks } from './activity.js';
import type { LinkIds } from './related.js';

const LEAD = '00Q000000000001AAA';
const OPP = '006000000000001AAA';
const ACCOUNT = '001000000000001AAA';
const links: LinkIds = { whoIds: [LEAD], whatIds: [OPP], parentIds: [LEAD, OPP, ACCOUNT] };
const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}T10:00:00.000+0000`;
const id = (n: number) => `00T${String(n).padStart(12, '0')}AAA`;

describe('readTasks', () => {
  it('queries Task by who or what, newest first, one past the cap', async () => {
    const rows = Array.from({ length: 26 }, (_, i) => ({ Id: id(i), Subject: `S${i}`, Description: 'd', Status: 'Completed', ActivityDate: '2026-09-01', CreatedDate: day(26 - i), CallDisposition: 'No Answer', TaskSubtype: 'Call' }));
    const sf = fakeSalesforce({ queries: [[/FROM Task/, rows]] });
    const out = await readTasks(sf.client, links);
    expect(sf.soql).toEqual([
      `SELECT Id, Subject, Description, Status, ActivityDate, CreatedDate, CallDisposition, TaskSubtype FROM Task WHERE (WhoId IN ('${LEAD}') OR WhatId IN ('${OPP}')) ORDER BY CreatedDate DESC LIMIT 26`,
    ]);
    expect(out.items).toHaveLength(25);
    expect(out.summary).toEqual({ source: 'tasks', status: 'ok', count: 25, truncated: true, note: null });
    expect(out.items[0]).toMatchObject({ source: 'task', title: 'S0', meta: { status: 'Completed', disposition: 'No Answer', kind: 'Call' } });
  });
  it('without whatIds the clause is WhoId only', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM Task/, []]] });
    await readTasks(sf.client, { whoIds: [LEAD], whatIds: [], parentIds: [LEAD] });
    expect(sf.soql[0]).toContain(`WHERE (WhoId IN ('${LEAD}')) ORDER BY`);
  });
  it('sends nothing when both lists are empty', async () => {
    const sf = fakeSalesforce({});
    expect((await readTasks(sf.client, { whoIds: [], whatIds: [], parentIds: [] })).summary.status).toBe('ok');
    expect(sf.soql).toEqual([]);
  });
});

describe('readEvents', () => {
  it('orders by start, newest first, and uses the start as the time', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM Event/, [{ Id: id(1), Subject: 'Walkthrough', Description: null, StartDateTime: day(5), EndDateTime: day(6), Location: 'Oak St', CreatedDate: day(1) }]]] });
    const out = await readEvents(sf.client, links);
    expect(sf.soql[0]).toContain('FROM Event WHERE (WhoId IN');
    expect(sf.soql[0]).toContain('ORDER BY StartDateTime DESC NULLS LAST LIMIT 11');
    expect(out.items[0]).toMatchObject({ source: 'event', at: day(5), title: 'Walkthrough', body: '', meta: { location: 'Oak St' } });
  });
});

describe('readNotes', () => {
  it('reads Note by parent and clips the body to 3,000', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM Note/, [{ Id: id(1), Title: 'Call', Body: 'x'.repeat(3_500), CreatedDate: day(2) }]]] });
    const out = await readNotes(sf.client, links);
    expect(sf.soql[0]).toBe(`SELECT Id, Title, Body, CreatedDate FROM Note WHERE ParentId IN ('${LEAD}', '${OPP}', '${ACCOUNT}') ORDER BY CreatedDate DESC LIMIT 11`);
    expect(out.items[0]?.body).toHaveLength(3_001);
  });
});

describe('readContentNotes', () => {
  const doc = (n: number, created: string, version: string | null = `0688000000${String(n).padStart(5, '0')}AAA`) => ({
    ContentDocumentId: `069${String(n).padStart(12, '0')}AAA`,
    ContentDocument: { Title: `Note ${n}`, LatestPublishedVersionId: version, CreatedDate: created },
  });

  it('lists SNOTE links, sorts newest first, fetches at most 10 bodies as plain text', async () => {
    const docs = Array.from({ length: 12 }, (_, i) => doc(i + 1, day(i + 1)));
    const sf = fakeSalesforce({
      queries: [[/FROM ContentDocumentLink/, docs]],
      requests: [[/VersionData$/, { status: 200, json: { raw: '<p>Roof&nbsp;leaks</p>' } }]],
    });
    const out = await readContentNotes(sf.client, links);
    expect(sf.soql[0]).toBe(
      `SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.LatestPublishedVersionId, ContentDocument.CreatedDate FROM ContentDocumentLink WHERE LinkedEntityId IN ('${LEAD}', '${OPP}', '${ACCOUNT}') AND ContentDocument.FileType = 'SNOTE' LIMIT 100`,
    );
    expect(sf.paths).toHaveLength(10);
    expect(sf.paths[0]).toBe('/sobjects/ContentVersion/068800000000012AAA/VersionData');
    expect(out.items[0]).toMatchObject({ source: 'content_note', title: 'Note 12', body: 'Roof leaks', at: day(12) });
    expect(out.summary).toMatchObject({ status: 'ok', count: 10, truncated: true });
  });

  it('one unreadable body drops that note only and says so', async () => {
    const sf = fakeSalesforce({
      queries: [[/FROM ContentDocumentLink/, [doc(1, day(1)), doc(2, day(2))]]],
      requests: [[/00002AAA/, { status: 404, json: null }], [/VersionData$/, { status: 200, json: { raw: 'ok' } }]],
    });
    const out = await readContentNotes(sf.client, links);
    expect(out.items.map((i) => i.title)).toEqual(['Note 1']);
    expect(out.summary).toMatchObject({ status: 'ok', count: 1, note: '1 note body unreadable' });
  });

  it('skips documents with no usable version id, and a malformed one is never fetched', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM ContentDocumentLink/, [doc(1, day(1), null), doc(2, day(2), "x/../y")]]] });
    const out = await readContentNotes(sf.client, links);
    expect(out.items).toEqual([]);
    expect(sf.paths).toEqual([]);
  });

  it('an outage while fetching a body throws', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM ContentDocumentLink/, [doc(1, day(1))]], ], requests: [[/VersionData$/, { status: 503, json: null }]] });
    await expect(readContentNotes(sf.client, links)).rejects.toBeInstanceOf(SalesforceApiError);
  });
});

describe('readEmails', () => {
  const email = (n: number, at: string, incoming: boolean) => ({ Id: `02s${String(n).padStart(12, '0')}AAA`, Subject: `Re ${n}`, TextBody: `<b>hi</b> ${n}`, FromAddress: 'a@x.com', ToAddress: 'b@x.com', MessageDate: at, Incoming: incoming });

  it('runs a RelatedToId query and an EmailMessageRelation semi-join, merges by Id, newest first', async () => {
    const shared = email(2, day(2), true);
    const sf = fakeSalesforce({
      queries: [
        [/WHERE RelatedToId IN/, [email(1, day(1), false), shared]],
        [/EmailMessageRelation/, [shared, email(3, day(3), true)]],
      ],
    });
    const out = await readEmails(sf.client, links);
    expect(sf.soql[0]).toBe(`SELECT Id, Subject, TextBody, FromAddress, ToAddress, MessageDate, Incoming FROM EmailMessage WHERE RelatedToId IN ('${OPP}') ORDER BY MessageDate DESC LIMIT 11`);
    expect(sf.soql[1]).toBe(
      `SELECT Id, Subject, TextBody, FromAddress, ToAddress, MessageDate, Incoming FROM EmailMessage WHERE Id IN (SELECT EmailMessageId FROM EmailMessageRelation WHERE RelationId IN ('${LEAD}')) ORDER BY MessageDate DESC LIMIT 11`,
    );
    expect(out.items.map((i) => i.title)).toEqual(['Re 3', 'Re 2', 'Re 1']);
    expect(out.items[0]).toMatchObject({ body: 'hi 3', meta: { direction: 'inbound', from: 'a@x.com', to: 'b@x.com' } });
    expect(out.items[2]?.meta.direction).toBe('outbound');
  });

  it('caps at 10 and clips the body at 2,000', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ ...email(i, day(i + 1), true), TextBody: 'y'.repeat(2_500) }));
    const sf = fakeSalesforce({ queries: [[/RelatedToId/, rows]] });
    const out = await readEmails(sf.client, { whoIds: [], whatIds: [OPP], parentIds: [OPP] });
    expect(out.items).toHaveLength(10);
    expect(out.summary.truncated).toBe(true);
    expect(out.items[0]?.body).toHaveLength(2_001);
  });

  it('INVALID_TYPE (no Enhanced Email) is a missing source, not a failure', async () => {
    const sf = fakeSalesforce({ queries: [[/EmailMessage/, new SalesforceApiError('x', 400, [{ errorCode: 'INVALID_TYPE', message: 'sObject type EmailMessage is not supported' }])]] });
    const out = await readEmails(sf.client, links);
    expect(out.summary).toEqual({ source: 'emails', status: 'missing', count: 0, truncated: false, note: 'INVALID_TYPE' });
  });

  it('does not send a query for an empty id list', async () => {
    const sf = fakeSalesforce({ queries: [[/RelatedToId/, []]] });
    await readEmails(sf.client, { whoIds: [], whatIds: [OPP], parentIds: [OPP] });
    expect(sf.soql).toHaveLength(1);
    const none = fakeSalesforce({});
    expect((await readEmails(none.client, { whoIds: [], whatIds: [], parentIds: [] })).items).toEqual([]);
    expect(none.soql).toEqual([]);
  });
});
