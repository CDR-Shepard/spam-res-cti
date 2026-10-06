import { describe, expect, it } from 'vitest';
import { SalesforceApiError } from '@cti/salesforce';
import { fakeSalesforce } from '../test/fake-sf-client.js';
import { rowsWhere } from '../test/fake-soql-where.js';
import { busySoql, readBusy, readUsers } from './calendar.js';

const GRANT = '0058X00000Fsx39QAB';
const OTHER = '0058X00000Abcd1QAB';
const userRow = (over: Record<string, unknown> = {}) => ({ Id: GRANT, FirstName: 'Grant', Name: 'Grant Golden', IsActive: true, TimeZoneSidKey: 'America/Los_Angeles', ...over });

describe('readUsers', () => {
  it('pins the SOQL and maps the rows', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM User/, [userRow(), userRow({ Id: OTHER, FirstName: 'Pat', Name: 'Pat Doe', IsActive: false, TimeZoneSidKey: 'America/New_York' })]]] });
    const users = await readUsers(sf.client, [GRANT, OTHER]);
    expect(sf.soql).toEqual([`SELECT Id, FirstName, Name, IsActive, TimeZoneSidKey FROM User WHERE Id IN ('${GRANT}', '${OTHER}')`]);
    expect(users.get(GRANT)).toEqual({ sfUserId: GRANT, firstName: 'Grant', name: 'Grant Golden', isActive: true, timeZone: 'America/Los_Angeles', zoneRefused: null });
    expect(users.get(OTHER)).toEqual({ sfUserId: OTHER, firstName: 'Pat', name: 'Pat Doe', isActive: false, timeZone: 'America/New_York', zoneRefused: null });
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

  it('a time zone the contract or Intl refuses falls back to America/Los_Angeles and says which; IsActive must be true exactly', async () => {
    const sf = fakeSalesforce({
      queries: [[/FROM User/, [userRow({ TimeZoneSidKey: 'Mars/Olympus_Mons', IsActive: 'true' }), userRow({ Id: OTHER, TimeZoneSidKey: null })]]],
    });
    const users = await readUsers(sf.client, [GRANT, OTHER]);
    expect(users.get(GRANT)).toMatchObject({ timeZone: 'America/Los_Angeles', zoneRefused: 'Mars/Olympus_Mons', isActive: false });
    // No zone at all is not a refusal worth naming.
    expect(users.get(OTHER)).toMatchObject({ timeZone: 'America/Los_Angeles', zoneRefused: null });
  });

  it.each(['GMT', 'UTC', 'Etc/GMT', 'Etc/UTC'])('Fix 1 (M-2): Salesforce\'s %s is UTC, not Los Angeles', async (TimeZoneSidKey) => {
    const sf = fakeSalesforce({ queries: [[/FROM User/, [userRow({ TimeZoneSidKey })]]] });
    expect((await readUsers(sf.client, [GRANT])).get(GRANT)).toMatchObject({ timeZone: 'Etc/UTC', zoneRefused: null });
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
  const LA = 'America/Los_Angeles';
  const allDayRow = (first: string, last = first) => ({ StartDateTime: `${first}T00:00:00.000+0000`, EndDateTime: `${last}T00:00:00.000+0000`, IsAllDayEvent: true, ActivityDate: first });
  const timedRow = (start: string, end: string) => ({ StartDateTime: start, EndDateTime: end, IsAllDayEvent: false });

  it('pins the SOQL: timed Events overlapping the range, all-day Events on a local date the range touches (Fix 1, I-1)', () => {
    expect(busySoql(GRANT, FROM, TO, LA)).toBe(
      `SELECT StartDateTime, EndDateTime, IsAllDayEvent, ActivityDate FROM Event WHERE OwnerId = '${GRANT}' AND ShowAs != 'Free' AND ` +
        '((IsAllDayEvent = false AND StartDateTime < 2026-10-21T15:00:00Z AND EndDateTime > 2026-10-06T15:00:00Z) OR ' +
        '(IsAllDayEvent = true AND StartDateTime <= 2026-10-21T00:00:00Z AND EndDateTime >= 2026-10-06T00:00:00Z)) ' +
        'ORDER BY StartDateTime LIMIT 2000',
    );
  });

  it('refuses an owner id that is not a Salesforce id', () => {
    expect(() => busySoql("005' OR OwnerId != '", FROM, TO, LA)).toThrow(/owner/i);
  });

  it('maps timed rows to instants and skips rows it cannot read', async () => {
    const sf = fakeSalesforce({
      queries: [[/FROM Event/, [
        { StartDateTime: '2026-10-07T18:00:00.000+0000', EndDateTime: '2026-10-07T19:00:00.000+0000', IsAllDayEvent: false, ActivityDate: '2026-10-07' },
        { StartDateTime: 'nonsense', EndDateTime: '2026-10-07T19:00:00.000+0000', IsAllDayEvent: false },
        { StartDateTime: '2026-10-08T18:00:00.000+0000', EndDateTime: null, IsAllDayEvent: false },
      ]]],
    });
    expect(await readBusy(sf.client, GRANT, FROM, TO, LA)).toEqual([
      { start: new Date('2026-10-07T18:00:00.000Z'), end: new Date('2026-10-07T19:00:00.000Z'), allDay: false },
    ]);
    expect(sf.soql).toEqual([busySoql(GRANT, FROM, TO, LA)]);
  });

  it('Fix 1 (I-1b): only rows inside the range come back, whatever Salesforce returned', async () => {
    const sf = fakeSalesforce({
      queries: [[/FROM Event/, [
        timedRow('2026-10-05T18:00:00.000+0000', '2026-10-05T19:00:00.000+0000'), // the day before: out
        timedRow('2026-10-06T14:00:00.000+0000', '2026-10-06T15:00:00.123+0000'), // ends exactly at FROM (touching): out
        timedRow('2026-10-06T14:00:00.000+0000', '2026-10-06T15:30:00.000+0000'), // across FROM: in
        timedRow('2026-10-21T15:00:00.000+0000', '2026-10-21T16:00:00.000+0000'), // starts exactly at TO: out
        allDayRow('2026-10-05'), // the local day before the range: out
        allDayRow('2026-10-21'), // the range's last local day (until 08:00): in
        allDayRow('2026-10-22'), // after the range: out
      ]]],
    });
    expect(await readBusy(sf.client, GRANT, FROM, TO, LA)).toEqual([
      { start: new Date('2026-10-06T14:00:00.000Z'), end: new Date('2026-10-06T15:30:00.000Z'), allDay: false },
      { start: new Date('2026-10-21T00:00:00.000Z'), end: new Date('2026-10-21T00:00:00.000Z'), allDay: true, day: { year: 2026, month: 10, day: 21 } },
    ]);
  });

  it('an all-day row maps to its ActivityDate (Salesforce stores it as midnight GMT, start = end)', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM Event/, [allDayRow('2026-10-07')]]] });
    expect(await readBusy(sf.client, GRANT, FROM, TO, LA)).toEqual([
      { start: new Date('2026-10-07T00:00:00.000Z'), end: new Date('2026-10-07T00:00:00.000Z'), allDay: true, day: { year: 2026, month: 10, day: 7 } },
    ]);
  });

  it('a multi-day all-day row blocks every day from ActivityDate to its end date', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM Event/, [allDayRow('2026-10-08', '2026-10-10')]]] });
    const busy = await readBusy(sf.client, GRANT, FROM, TO, LA);
    expect(busy.map((b) => b.day)).toEqual([
      { year: 2026, month: 10, day: 8 },
      { year: 2026, month: 10, day: 9 },
      { year: 2026, month: 10, day: 10 },
    ]);
    expect(busy.every((b) => b.allDay)).toBe(true);
  });

  it('a long all-day row is cut to the local days the range touches; one without a readable date is skipped', async () => {
    const sf = fakeSalesforce({
      queries: [[/FROM Event/, [allDayRow('2026-01-01', '2027-12-31'), { StartDateTime: null, EndDateTime: null, IsAllDayEvent: true, ActivityDate: null }]]],
    });
    const days = (await readBusy(sf.client, GRANT, FROM, TO, LA)).map((b) => `${b.day!.month}/${b.day!.day}`);
    expect(days[0]).toBe('10/6');
    expect(days.at(-1)).toBe('10/21');
    expect(days).toHaveLength(16);
  });

  it('an all-day row without ActivityDate falls back to its start date', async () => {
    const sf = fakeSalesforce({ queries: [[/FROM Event/, [{ ...allDayRow('2026-10-09'), ActivityDate: null }]]] });
    expect((await readBusy(sf.client, GRANT, FROM, TO, LA)).map((b) => b.day)).toEqual([{ year: 2026, month: 10, day: 9 }]);
  });

  describe('Fix 1 (I-1a): today\'s all-day Event late in the local day, past midnight UTC (Salesforce answers by the query)', () => {
    const table = [
      allDayRow('2026-10-06'),
      allDayRow('2026-10-04', '2026-10-06'), // a multi-day all-day Event ending today
      timedRow('2026-10-06T18:00:00.000+0000', '2026-10-06T19:00:00.000+0000'), // earlier today: over
    ];
    it.each([
      ['Pacific/Honolulu', '2026-10-07T00:30:00.000Z'], // Tue 10/6 14:30 HST
      ['America/Los_Angeles', '2026-10-07T00:30:00.000Z'], // Tue 10/6 17:30 PDT
      ['America/Los_Angeles', '2026-10-07T06:59:00.000Z'], // Tue 10/6 23:59 PDT
    ])('%s at %s: both all-day Events block today, the timed one that ended is gone', async (zone, at) => {
      const from = new Date(at);
      const sf = fakeSalesforce({ queries: [[/FROM Event/, (q) => rowsWhere(q, table)]] });
      const busy = await readBusy(sf.client, GRANT, from, new Date(from.getTime() + 15 * 86_400_000), zone);
      expect(busy).toEqual([
        { start: new Date('2026-10-06T00:00:00.000Z'), end: new Date('2026-10-06T00:00:00.000Z'), allDay: true, day: { year: 2026, month: 10, day: 6 } },
        { start: new Date('2026-10-04T00:00:00.000Z'), end: new Date('2026-10-06T00:00:00.000Z'), allDay: true, day: { year: 2026, month: 10, day: 6 } },
      ]);
    });
  });
});
