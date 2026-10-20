import { describe, expect, it } from 'vitest';
import { Consultations } from '@cti/contracts';
import { SalesforceApiError } from '@cti/salesforce';
import { fakeSalesforce } from '../test/fake-sf-client.js';
import { consultationLinks, consultationsSoql, readConsultations } from './consultations.js';

const LEAD = '00Q8X00000AbcdEUAV';
const CONTACT = '0038X00000BcdeFQAR';
const OPP_A = '0068X00000CdefGQAT';
const OPP_B = '0068X00000DefgHQAT';
const ACCOUNT = '0018X00000EfghIQAT';
const NOW = new Date('2026-10-19T16:00:00Z');

describe('consultationLinks', () => {
  it('an Opportunity: itself and the other Opportunities as What, Contacts as Who, Accounts ignored, each once', () => {
    const links = consultationLinks({ sfObject: 'Opportunity', sfRecordId: OPP_A }, [
      { sfObject: 'Contact', id: CONTACT },
      { sfObject: 'Account', id: ACCOUNT },
      { sfObject: 'Opportunity', id: OPP_B },
      { sfObject: 'Opportunity', id: OPP_A },
    ]);
    expect(links).toEqual({ whoIds: [CONTACT], whatIds: [OPP_A, OPP_B] });
  });

  it('a Lead with nothing around it is the only Who', () => {
    expect(consultationLinks({ sfObject: 'Lead', sfRecordId: LEAD })).toEqual({ whoIds: [LEAD], whatIds: [] });
  });

  it('a converted Lead: its Contact and Opportunity come along', () => {
    const links = consultationLinks({ sfObject: 'Lead', sfRecordId: LEAD }, [
      { sfObject: 'Contact', id: CONTACT },
      { sfObject: 'Opportunity', id: OPP_A },
    ]);
    expect(links).toEqual({ whoIds: [LEAD, CONTACT], whatIds: [OPP_A] });
  });

  it('drops a malformed id, and an id whose key prefix is not its object', () => {
    const links = consultationLinks({ sfObject: 'Opportunity', sfRecordId: OPP_A }, [
      { sfObject: 'Contact', id: "003' OR Id != '" },
      { sfObject: 'Contact', id: 'abc' },
      { sfObject: 'Contact', id: OPP_B },
      { sfObject: 'Opportunity', id: CONTACT },
      { sfObject: 'Lead', id: '' },
    ]);
    expect(links).toEqual({ whoIds: [], whatIds: [OPP_A] });
    expect(consultationLinks({ sfObject: 'Lead', sfRecordId: 'nope' })).toEqual({ whoIds: [], whatIds: [] });
  });

  it('the same record in its 15 and 18 character forms is one id, the first form seen', () => {
    const links = consultationLinks({ sfObject: 'Opportunity', sfRecordId: OPP_A }, [{ sfObject: 'Opportunity', id: OPP_A.slice(0, 15) }]);
    expect(links.whatIds).toEqual([OPP_A]);
  });
});

describe('consultationsSoql', () => {
  it('pins the text for one Opportunity id', () => {
    expect(consultationsSoql({ whoIds: [], whatIds: [OPP_A] })).toBe(
      `SELECT StartDateTime, Subject, Owner.Name FROM Event WHERE Subject LIKE '%Consultation%' AND IsAllDayEvent = false AND (WhatId IN ('${OPP_A}')) ORDER BY StartDateTime DESC LIMIT 50`,
    );
  });

  it('asks both lists when both have ids, and leaves out an empty one', () => {
    expect(consultationsSoql({ whoIds: [LEAD, CONTACT], whatIds: [OPP_A, OPP_B] })).toContain(
      `AND (WhoId IN ('${LEAD}', '${CONTACT}') OR WhatId IN ('${OPP_A}', '${OPP_B}')) ORDER BY`,
    );
    expect(consultationsSoql({ whoIds: [LEAD], whatIds: [] })).toContain(`AND (WhoId IN ('${LEAD}')) ORDER BY`);
  });

  it('is null when both lists are empty', () => {
    expect(consultationsSoql({ whoIds: [], whatIds: [] })).toBeNull();
  });
});

const row = (StartDateTime: string, Subject: string | null, ownerName: string | null = null) => ({ StartDateTime, Subject, Owner: ownerName === null ? null : { Name: ownerName } });
const LINKS = { whoIds: [], whatIds: [OPP_A] };

describe('readConsultations', () => {
  const rows = [
    row('2026-10-22T18:00:00.000Z', 'Phone Consultation', 'Seth Boisvert'),
    row('2026-03-12T17:00:00.000Z', 'Property Consultation 12 Example Street', 'Blake Kossuth'),
    row('2025-11-01T17:00:00.000Z', 'Property Consultation', 'Nolan Weber'),
  ];

  it('the latest one before now is last, the earliest from now on is next; the result fits the contract', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM Event/, rows]] });
    const result = await readConsultations(sf.client, LINKS, NOW);
    expect(result).toEqual({
      last: { start: '2026-03-12T17:00:00.000Z', kind: 'in_person', ownerName: 'Blake Kossuth' },
      next: { start: '2026-10-22T18:00:00.000Z', kind: 'phone', ownerName: 'Seth Boisvert' },
    });
    expect(Consultations.safeParse(result).success).toBe(true);
    expect(sf.soql).toEqual([consultationsSoql(LINKS)]);
  });

  it('picks by time, not by the order the rows come back in; several upcoming → the earliest', async () => {
    const sf = fakeSalesforce({
      queries: [[/FROM Event/, [
        row('2026-11-05T18:00:00.000Z', 'Property Consultation', 'Seth Boisvert'),
        row('2025-11-01T17:00:00.000Z', 'Property Consultation', 'Nolan Weber'),
        row('2026-10-25T18:00:00.000Z', 'Property Consultation', 'Thomas Wilkinson'),
        row('2026-03-12T17:00:00.000Z', 'Property Consultation', 'Blake Kossuth'),
      ]]],
    });
    const result = await readConsultations(sf.client, LINKS, NOW);
    expect(result.last).toMatchObject({ start: '2026-03-12T17:00:00.000Z', ownerName: 'Blake Kossuth' });
    expect(result.next).toMatchObject({ start: '2026-10-25T18:00:00.000Z', ownerName: 'Thomas Wilkinson' });
  });

  it('one that starts exactly now is upcoming, not past', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM Event/, [row('2026-10-19T16:00:00.000Z', 'Property Consultation', 'Blake Kossuth')]]] });
    expect(await readConsultations(sf.client, LINKS, NOW)).toEqual({ last: null, next: { start: '2026-10-19T16:00:00.000Z', kind: 'in_person', ownerName: 'Blake Kossuth' } });
  });

  it('only past ones leave next empty; no rows leave both empty', async () => {
    const past = fakeSalesforce({ queries: [[/FROM Event/, [rows[2]!]]] });
    expect(await readConsultations(past.client, LINKS, NOW)).toEqual({ last: { start: '2025-11-01T17:00:00.000Z', kind: 'in_person', ownerName: 'Nolan Weber' }, next: null });
    const none = fakeSalesforce({ queries: [[/FROM Event/, []]] });
    expect(await readConsultations(none.client, LINKS, NOW)).toEqual({ last: null, next: null });
  });

  it('reads the +0000 instants Salesforce returns and writes them as ISO', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM Event/, [row('2026-10-22T18:00:00.000+0000', 'Phone Consultation', 'Seth Boisvert')]]] });
    expect((await readConsultations(sf.client, LINKS, NOW)).next?.start).toBe('2026-10-22T18:00:00.000Z');
  });

  it.each([
    ['Phone Consultation', 'phone'],
    ['phone consultation', 'phone'],
    ['PHONE CONSULTATION', 'phone'],
    ['phone consultation - rescheduled', 'phone'],
    ['Property Consultation 40 Telephone Rd', 'in_person'],
    ['Property Consultation 12 Phone Line Ln', 'in_person'],
    ['Property Consultation', 'in_person'],
    ['High Priority Property Consultation', 'in_person'],
    [null, 'in_person'],
  ])('Subject %j is %s', async (subject, kind) => {
    const sf = fakeSalesforce({ queries: [[/FROM Event/, [row('2026-10-22T18:00:00.000Z', subject, 'Seth Boisvert')]]] });
    expect((await readConsultations(sf.client, LINKS, NOW)).next?.kind).toBe(kind);
  });

  it.each([
    ['Calendar: Team #2', null],
    ['Seth Boisvert', 'Seth Boisvert'],
    ["Mary-Ann O'Neil Jr.", "Mary-Ann O'Neil Jr."],
    ['  Seth Boisvert  ', 'Seth Boisvert'],
    ['Seth\nBoisvert', null],
    ['', null],
    ['   ', null],
    ['A'.repeat(81), null],
  ])('Owner.Name %j gives ownerName %j', async (name, expected) => {
    const sf = fakeSalesforce({ queries: [[/FROM Event/, [row('2026-10-22T18:00:00.000Z', 'Property Consultation', name)]]] });
    expect((await readConsultations(sf.client, LINKS, NOW)).next?.ownerName).toBe(expected);
  });

  it('a missing Owner gives a null ownerName, and rows with no readable start are skipped', async () => {
    const sf = fakeSalesforce({
      queries: [[/FROM Event/, [
        { StartDateTime: null, Subject: 'Property Consultation', Owner: { Name: 'Nolan Weber' } },
        { StartDateTime: 'not a date', Subject: 'Property Consultation', Owner: { Name: 'Nolan Weber' } },
        { Subject: 'Property Consultation' },
        row('2026-10-22T18:00:00.000Z', 'Property Consultation'),
      ]]],
    });
    expect(await readConsultations(sf.client, LINKS, NOW)).toEqual({ last: null, next: { start: '2026-10-22T18:00:00.000Z', kind: 'in_person', ownerName: null } });
  });

  it('never returns the Subject', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM Event/, rows]] });
    expect(JSON.stringify(await readConsultations(sf.client, LINKS, NOW))).not.toMatch(/Example Street/);
  });

  it('asks nothing when there are no links', async () => {
    const sf = fakeSalesforce({ queries: [] });
    expect(await readConsultations(sf.client, { whoIds: [], whatIds: [] }, NOW)).toEqual({ last: null, next: null });
    expect(sf.soql).toEqual([]);
  });

  it('a Salesforce error is thrown to the caller, not swallowed', async () => {
    const err = new SalesforceApiError('boom', 503, [{ errorCode: 'SERVER_UNAVAILABLE' }]);
    const sf = fakeSalesforce({ queries: [[/FROM Event/, err]] });
    await expect(readConsultations(sf.client, LINKS, NOW)).rejects.toBe(err);
  });
});
