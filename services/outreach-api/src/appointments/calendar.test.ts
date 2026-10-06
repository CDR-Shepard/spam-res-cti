import { describe, expect, it } from 'vitest';
import { SalesforceApiError } from '@cti/salesforce';
import { fakeSalesforce } from '../test/fake-sf-client.js';
import { busySoql, readBusy, readUsers } from './calendar.js';

const GRANT = '0058X00000Fsx39QAB';
const OTHER = '0058X00000Abcd1QAB';
const userRow = (over: Record<string, unknown> = {}) => ({ Id: GRANT, FirstName: 'Grant', Name: 'Grant Golden', IsActive: true, TimeZoneSidKey: 'America/Los_Angeles', ...over });

describe('readUsers', () => {
  it('pins the SOQL and maps the rows', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM User/, [userRow(), userRow({ Id: OTHER, FirstName: 'Pat', Name: 'Pat Doe', IsActive: false, TimeZoneSidKey: 'America/New_York' })]]] });
    const users = await readUsers(sf.client, [GRANT, OTHER]);
    expect(sf.soql).toEqual([`SELECT Id, FirstName, Name, IsActive, TimeZoneSidKey FROM User WHERE Id IN ('${GRANT}', '${OTHER}')`]);
    expect(users.get(GRANT)).toEqual({ sfUserId: GRANT, firstName: 'Grant', name: 'Grant Golden', isActive: true, timeZone: 'America/Los_Angeles' });
    expect(users.get(OTHER)).toEqual({ sfUserId: OTHER, firstName: 'Pat', name: 'Pat Doe', isActive: false, timeZone: 'America/New_York' });
  });

  it('drops a bad id before querying, and does not query when none is left', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM User/, [userRow()]]] });
    await readUsers(sf.client, [GRANT, "005' OR Id != '", 'abc']);
    expect(sf.soql).toEqual([`SELECT Id, FirstName, Name, IsActive, TimeZoneSidKey FROM User WHERE Id IN ('${GRANT}')`]);
    const none = fakeSalesforce({ queries: [] });
    expect((await readUsers(none.client, ['abc', ''])).size).toBe(0);
    expect((await readUsers(none.client, [])).size).toBe(0);
    expect(none.soql).toEqual([]);
  });

  it.each([
    ['Grant', 'Grant'],
    ["D'Angelo", "D'Angelo"],
    ['Mary Ann', 'Mary Ann'],
    ['<b>', null],
    ['', null],
    [null, null],
    [42, null],
    ['José', null],
    ['A'.repeat(41), null],
    ['1st', null],
  ])('first name %j gives %j', async (FirstName, expected) => {
    const sf = fakeSalesforce({ queries: [[/FROM User/, [userRow({ FirstName })]]] });
    expect((await readUsers(sf.client, [GRANT])).get(GRANT)?.firstName).toBe(expected);
  });

  it('a time zone the contract or Intl refuses falls back to America/Los_Angeles; IsActive must be true exactly', async () => {
    const sf = fakeSalesforce({
      queries: [[/FROM User/, [userRow({ TimeZoneSidKey: 'GMT', IsActive: 'true' }), userRow({ Id: OTHER, TimeZoneSidKey: 'Mars/Olympus_Mons' })]]],
    });
    const users = await readUsers(sf.client, [GRANT, OTHER]);
    expect(users.get(GRANT)).toMatchObject({ timeZone: 'America/Los_Angeles', isActive: false });
    expect(users.get(OTHER)?.timeZone).toBe('America/Los_Angeles');
  });

  it('skips a row without a valid id or name', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM User/, [userRow({ Id: null }), userRow({ Id: OTHER, Name: null })]]] });
    expect((await readUsers(sf.client, [GRANT, OTHER])).size).toBe(0);
  });

  it('a Salesforce failure propagates (the offer turns it into salesforce_error)', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM User/, new SalesforceApiError('boom', 500, null)]] });
    await expect(readUsers(sf.client, [GRANT])).rejects.toBeInstanceOf(SalesforceApiError);
  });
});

describe('readBusy', () => {
  const FROM = new Date('2026-10-06T15:00:00.123Z');
  const TO = new Date('2026-10-21T15:00:00.000Z');

  it('pins the SOQL: the owner\'s non-free Events overlapping the range; the lower bound a day early for all-day Events', () => {
    expect(busySoql(GRANT, FROM, TO)).toBe(
      `SELECT StartDateTime, EndDateTime, IsAllDayEvent, ActivityDate FROM Event WHERE OwnerId = '${GRANT}' AND ShowAs != 'Free' AND StartDateTime < 2026-10-21T15:00:00Z AND EndDateTime > 2026-10-05T15:00:00Z ORDER BY StartDateTime LIMIT 2000`,
    );
  });

  it('refuses an owner id that is not a Salesforce id', () => {
    expect(() => busySoql("005' OR OwnerId != '", FROM, TO)).toThrow(/owner/i);
  });

  it('maps timed rows to instants and skips rows it cannot read', async () => {
    const sf = fakeSalesforce({
      queries: [[/FROM Event/, [
        { StartDateTime: '2026-10-07T18:00:00.000+0000', EndDateTime: '2026-10-07T19:00:00.000+0000', IsAllDayEvent: false, ActivityDate: '2026-10-07' },
        { StartDateTime: 'nonsense', EndDateTime: '2026-10-07T19:00:00.000+0000', IsAllDayEvent: false },
        { StartDateTime: '2026-10-08T18:00:00.000+0000', EndDateTime: null, IsAllDayEvent: false },
      ]]],
    });
    expect(await readBusy(sf.client, GRANT, FROM, TO)).toEqual([
      { start: new Date('2026-10-07T18:00:00.000Z'), end: new Date('2026-10-07T19:00:00.000Z'), allDay: false },
    ]);
    expect(sf.soql).toEqual([busySoql(GRANT, FROM, TO)]);
  });

  it('an all-day row maps to its ActivityDate (Salesforce stores it as midnight GMT, start = end)', async () => {
    const sf = fakeSalesforce({
      queries: [[/FROM Event/, [{ StartDateTime: '2026-10-07T00:00:00.000+0000', EndDateTime: '2026-10-07T00:00:00.000+0000', IsAllDayEvent: true, ActivityDate: '2026-10-07' }]]],
    });
    expect(await readBusy(sf.client, GRANT, FROM, TO)).toEqual([
      { start: new Date('2026-10-07T00:00:00.000Z'), end: new Date('2026-10-07T00:00:00.000Z'), allDay: true, day: { year: 2026, month: 10, day: 7 } },
    ]);
  });

  it('a multi-day all-day row blocks every day from ActivityDate to its end date', async () => {
    const sf = fakeSalesforce({
      queries: [[/FROM Event/, [{ StartDateTime: '2026-10-08T00:00:00.000+0000', EndDateTime: '2026-10-10T00:00:00.000+0000', IsAllDayEvent: true, ActivityDate: '2026-10-08' }]]],
    });
    const busy = await readBusy(sf.client, GRANT, FROM, TO);
    expect(busy.map((b) => b.day)).toEqual([
      { year: 2026, month: 10, day: 8 },
      { year: 2026, month: 10, day: 9 },
      { year: 2026, month: 10, day: 10 },
    ]);
    expect(busy.every((b) => b.allDay)).toBe(true);
  });

  it('a long all-day row is cut to the days around the range; one without a readable date is skipped', async () => {
    const sf = fakeSalesforce({
      queries: [[/FROM Event/, [
        { StartDateTime: '2026-01-01T00:00:00.000+0000', EndDateTime: '2027-12-31T00:00:00.000+0000', IsAllDayEvent: true, ActivityDate: '2026-01-01' },
        { StartDateTime: null, EndDateTime: null, IsAllDayEvent: true, ActivityDate: null },
      ]]],
    });
    const days = (await readBusy(sf.client, GRANT, FROM, TO)).map((b) => `${b.day!.month}/${b.day!.day}`);
    expect(days[0]).toBe('10/4');
    expect(days.at(-1)).toBe('10/22');
    expect(days).toContain('10/6');
  });

  it('an all-day row without ActivityDate falls back to its start date', async () => {
    const sf = fakeSalesforce({
      queries: [[/FROM Event/, [{ StartDateTime: '2026-10-09T00:00:00.000+0000', EndDateTime: '2026-10-09T00:00:00.000+0000', IsAllDayEvent: true, ActivityDate: null }]]],
    });
    expect((await readBusy(sf.client, GRANT, FROM, TO)).map((b) => b.day)).toEqual([{ year: 2026, month: 10, day: 9 }]);
  });
});
