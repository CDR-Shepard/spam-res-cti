import { describe, expect, it, vi } from 'vitest';
import type { AiCallBookingSettings } from '@cti/contracts';
import { SalesforceApiError } from '@cti/salesforce';
import { DEFAULT_AI_CALL_BOOKING, DEFAULT_BOOKING_ROUTING } from '../settings.js';
import { fakeBookedDb, fakeMaps, GRANT, offerSalesforce, SETH, THOMAS, usersWithInactive } from '../test/fake-offer.js';
import { describeOf, type QueryRoute } from '../test/fake-sf-client.js';
import { readOfferCalendars, type OfferCalendars } from './offer.js';
import { offerForRecord, type RecordOfferInput } from './offer-for-record.js';

type Row = Record<string, unknown>;

const ORG = '00000000-0000-4000-8000-0000000000a3';
/** Mon 2026-10-19 09:00 PDT. */
const NOW = new Date('2026-10-19T16:00:00Z');
const LEAD = '00Q8X00000AbcdEUAV';
const OPP = '0068X00000CdefGQAT';
const OPP_B = '0068X00000DefgHQAT';
const CONTACT = '0038X00000BcdeFQAR';
const ACCOUNT = '0018X00000EfghIQAT';
const booking = (over: Partial<AiCallBookingSettings> = {}): AiCallBookingSettings => ({
  ...structuredClone(DEFAULT_AI_CALL_BOOKING), enabled: true, specialists: [GRANT], routing: structuredClone(DEFAULT_BOOKING_ROUTING), ...over,
});
// A made-up San Diego property, split as the records hold it.
const leadRow: Row = { Id: LEAD, Name: 'Pat Seller', Street: '123 Palm Ave', City: 'San Diego', State: 'CA', PostalCode: '92101', IsConverted: false };
const oppRow: Row = { Id: OPP, Name: 'Pat Seller Opp', Street__c: '123 Palm Ave', City__c: 'San Diego', State__c: 'CA', Zipcode__c: '92101' };
const OPP_DESCRIBE = describeOf('Opportunity', [['Id'], ['Name'], ['Street__c'], ['City__c'], ['State__c'], ['Zipcode__c']]);
const pastConsultation: Row = { StartDateTime: '2026-10-01T17:00:00.000+0000', Subject: 'Property Consultation', Owner: { Name: 'Seth Boisvert' } };
const upcomingConsultation: Row = { StartDateTime: '2026-10-22T17:00:00.000+0000', Subject: 'Phone Consultation', Owner: { Name: 'Seth Boisvert' } };

interface Case {
  record?: RecordOfferInput['record'];
  around?: RecordOfferInput['around'];
  consultations?: Row[] | Error;
  records?: QueryRoute[];
  booking?: AiCallBookingSettings;
  users?: Row[];
}

function run(c: Case = {}) {
  const sf = offerSalesforce({
    consultations: c.consultations ?? [pastConsultation],
    users: c.users,
    extra: c.records ?? [[/FROM Lead /, [leadRow]], [/FROM Opportunity /, [oppRow]]],
  });
  const b = c.booking ?? booking();
  const calendars = vi.fn((): Promise<OfferCalendars> => readOfferCalendars(sf.client, { booking: b, now: NOW }));
  const oppDescribe = vi.fn(async () => OPP_DESCRIBE);
  const log = { info: vi.fn(), warn: vi.fn() };
  const deps = { db: fakeBookedDb().db, maps: fakeMaps().maps, log, client: sf.client, calendars, oppDescribe };
  const input: RecordOfferInput = { orgId: ORG, booking: b, now: NOW, record: c.record ?? { sfObject: 'Lead', sfRecordId: LEAD }, around: c.around ?? [] };
  return { sf, log, oppDescribe, calendars, result: offerForRecord(deps, input) };
}

const consultationSoql = (soql: readonly string[]) => soql.filter((q) => q.includes("Subject LIKE '%Consultation%'"));
const recordSoql = (soql: readonly string[]) => soql.filter((q) => / FROM (Lead|Opportunity) /.test(q));

describe('offerForRecord', () => {
  it('consultations are read with links from the record plus around, and come back with the offer', async () => {
    const { sf, result } = run({
      record: { sfObject: 'Opportunity', sfRecordId: OPP },
      around: [{ sfObject: 'Contact', id: CONTACT }, { sfObject: 'Opportunity', id: OPP_B }, { sfObject: 'Account', id: ACCOUNT }],
    });
    const { offer, consultations } = await result;
    const [soql] = consultationSoql(sf.soql);
    expect(soql).toContain(`WhoId IN ('${CONTACT}')`);
    expect(soql).toContain(`WhatId IN ('${OPP}', '${OPP_B}')`);
    expect(soql).not.toContain(ACCOUNT);
    expect(consultations).toEqual({ last: { start: '2026-10-01T17:00:00.000Z', kind: 'in_person', ownerName: 'Seth Boisvert' }, next: null });
    expect(offer).toMatchObject({ region: 'SD', note: null });
    expect(offer.slots.length).toBeGreaterThan(0);
  });

  it('a consultations read error with booking on: no times and no priority (a booked one cannot be ruled out), note salesforce_error', async () => {
    const { log, result } = run({ consultations: new SalesforceApiError('INVALID_FIELD: Owner.Name', 400, null) });
    const { offer, consultations } = await result;
    expect(consultations).toBeNull();
    expect(offer).toEqual({ slots: [], priority: null, region: 'SD', ownerSfUserId: null, note: 'salesforce_error' });
    expect(log.warn).toHaveBeenCalledWith({ orgId: ORG, errName: 'SalesforceApiError' }, expect.any(String));
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('INVALID_FIELD');
  });

  it('a consultations read error drops a priority-only offer too', async () => {
    const users = usersWithInactive(SETH, THOMAS);
    const { result } = run({ users, consultations: new SalesforceApiError('boom', 500, null) });
    expect((await result).offer).toEqual({ slots: [], priority: null, region: 'SD', ownerSfUserId: null, note: 'salesforce_error' });
    // Without the error, the same record gets Grant's priority offer, so the test can fail.
    expect((await run({ users }).result).offer.priority?.specialistSfUserId).toBe(GRANT);
  });

  it('a consultations read error keeps a note that has nothing to drop (booking off, no address)', async () => {
    const failed = new SalesforceApiError('boom', 500, null);
    expect((await run({ consultations: failed, booking: booking({ enabled: false }) }).result).offer.note).toBe('booking_off');
    expect((await run({ consultations: failed, records: [[/FROM Lead /, [{ ...leadRow, IsConverted: true }]]] }).result).offer.note).toBe('no_address');
  });

  it('a Lead target makes no Opportunity describe call', async () => {
    const { sf, oppDescribe, result } = run({ record: { sfObject: 'Lead', sfRecordId: LEAD } });
    const { offer } = await result;
    expect(offer.region).toBe('SD');
    expect(oppDescribe).not.toHaveBeenCalled();
    expect(sf.described).toEqual([]);
    expect(recordSoql(sf.soql)).toHaveLength(1);
  });

  it('an Opportunity target reads its address with the given describe, never describing it again', async () => {
    const { sf, oppDescribe, result } = run({ record: { sfObject: 'Opportunity', sfRecordId: OPP } });
    const { offer } = await result;
    expect(offer.region).toBe('SD');
    expect(oppDescribe).toHaveBeenCalledTimes(1);
    expect(sf.described).toEqual([]);
    expect(recordSoql(sf.soql)[0]).toContain('Street__c');
  });

  it('booking off: the consultations are still read (Sam mentions them), the record is not', async () => {
    const { sf, result } = run({ booking: booking({ enabled: false }) });
    const { offer, consultations } = await result;
    expect(offer).toEqual({ slots: [], priority: null, region: null, ownerSfUserId: null, note: 'booking_off' });
    expect(consultations?.last?.kind).toBe('in_person');
    expect(recordSoql(sf.soql)).toEqual([]);
  });

  it('an upcoming consultation: already_booked, and the record is not read', async () => {
    const { sf, result } = run({ consultations: [upcomingConsultation, pastConsultation] });
    const { offer, consultations } = await result;
    expect(offer.note).toBe('already_booked');
    expect(consultations?.next).toEqual({ start: '2026-10-22T17:00:00.000Z', kind: 'phone', ownerName: 'Seth Boisvert' });
    expect(recordSoql(sf.soql)).toEqual([]);
  });

  it('a converted Lead has no address: no_address', async () => {
    const { result } = run({ records: [[/FROM Lead /, [{ ...leadRow, IsConverted: true }]]] });
    expect((await result).offer.note).toBe('no_address');
  });

  it('the record read failing: salesforce_error, logged by its error name; the consultations still come back', async () => {
    const { log, result } = run({ records: [[/FROM Lead /, new SalesforceApiError('boom', 500, null)]] });
    const { offer, consultations } = await result;
    expect(offer).toEqual({ slots: [], priority: null, region: null, ownerSfUserId: null, note: 'salesforce_error' });
    expect(consultations?.last).not.toBeNull();
    expect(log.warn).toHaveBeenCalledWith({ orgId: ORG, errName: 'SalesforceApiError' }, expect.any(String));
  });

  it('never throws: a calendars read that rejects is salesforce_error', async () => {
    const sf = offerSalesforce({ extra: [[/FROM Lead /, [leadRow]]] });
    const deps = {
      db: fakeBookedDb().db, maps: fakeMaps().maps, log: { info: vi.fn(), warn: vi.fn() }, client: sf.client,
      calendars: async (): Promise<OfferCalendars> => { throw new Error('bug'); },
    };
    const { offer } = await offerForRecord(deps, { orgId: ORG, booking: booking(), now: NOW, record: { sfObject: 'Lead', sfRecordId: LEAD }, around: [] });
    expect(offer.note).toBe('salesforce_error');
  });
});
