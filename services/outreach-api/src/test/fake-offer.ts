/**
 * Stand-ins for the routed appointment offer's tests: the region reps and Grant as Salesforce users, a Salesforce client that
 * answers the User and busy Event reads like Salesforce (rowsWhere), a Google Maps client answering from a table of made-up
 * places, and a database that answers the AI-bookings read with stored appointments.
 */
import type { Db } from '@cti/db';
import type { Geocoded, MapsClient } from '../appointments/maps.js';
import { fakeSalesforce, type FakeSf, type QueryRoute } from './fake-sf-client.js';
import { rowsWhere } from './fake-soql-where.js';

type Row = Record<string, unknown>;

export const CHANCE = '0055f000005qXn8AAE';
export const BLAKE = '0058X00000FA8tLQAT';
export const SETH = '0055f000005qXVfAAM';
export const THOMAS = '0055f000005qYO6AAM';
export const GRANT = '0058X00000Fsx39QAB';

export const userRow = (Id: string, FirstName: string, over: Row = {}): Row => ({
  Id, FirstName, Name: `${FirstName} Person`, IsActive: true, TimeZoneSidKey: 'America/Los_Angeles', ...over,
});
export const USERS: readonly Row[] = [
  userRow(CHANCE, 'Chance'), userRow(BLAKE, 'Blake'), userRow(SETH, 'Seth'), userRow(THOMAS, 'Thomas'), userRow(GRANT, 'Grant'),
];
/** The users with the ones named here inactive. */
export const usersWithInactive = (...ids: string[]): Row[] => USERS.map((u) => (ids.includes(u.Id as string) ? { ...u, IsActive: false } : u));

/** A timed Event row as the busy read selects it. */
export const eventRow = (OwnerId: string, start: string, end: string, over: Row = {}): Row => ({
  OwnerId, StartDateTime: start, EndDateTime: end, IsAllDayEvent: false, ActivityDate: start.slice(0, 10), Location: null, Subject: 'Meeting', ...over,
});

// Made-up places.
export const OFFICE_ADDRESS = '18872 MacArthur Blvd #220, Irvine, CA 92612';
export const SD_PROPERTY = '123 Palm Ave, San Diego, CA 92101';
export const OC_PROPERTY = '456 Fake Oak Ave, Irvine, CA 92614';
export const IMPERIAL_PROPERTY = '789 Desert Rd, El Centro, CA 92243';
export const SD_CITY_ONLY = 'San Diego, CA';
/** SD_PROPERTY split as a Lead holds it (the record read joins it back to SD_PROPERTY). */
export const SD_LEAD_ADDRESS: Readonly<Row> = { Street: '123 Palm Ave', City: 'San Diego', State: 'CA', PostalCode: '92101' };
export const ANAHEIM = '100 Main St, Anaheim, CA 92805';

const at = (lat: number, lng: number, county: string): Geocoded => ({ point: { lat, lng }, county, state: 'CA' });
export const PLACES: Readonly<Record<string, Geocoded>> = {
  [OFFICE_ADDRESS]: at(33.6595, -117.8608, 'Orange'),
  [SD_PROPERTY]: at(32.7157, -117.1611, 'San Diego'),
  [OC_PROPERTY]: at(33.6846, -117.8265, 'Orange'),
  [IMPERIAL_PROPERTY]: at(32.792, -115.563, 'Imperial'),
  [SD_CITY_ONLY]: at(32.7157, -117.1611, 'San Diego'),
  [ANAHEIM]: at(33.8366, -117.9143, 'Orange'),
};

/**
 * Salesforce for an offer: the User and busy Event reads answered from tables through rowsWhere (so `Id IN`, `OwnerId IN` and
 * the time window filter as Salesforce would), the consultations read by route, and any `extra` routes (record reads).
 */
export function offerSalesforce(o: { users?: readonly Row[]; events?: readonly Row[]; consultations?: Row[] | Error; extra?: QueryRoute[] } = {}): FakeSf {
  return fakeSalesforce({
    queries: [
      [/Subject LIKE '%Consultation%'/, o.consultations ?? []],
      [/FROM Event WHERE OwnerId/, (q) => rowsWhere(q, o.events ?? [])],
      [/FROM User /, (q) => rowsWhere(q, o.users ?? USERS)],
      ...(o.extra ?? []),
    ],
  });
}

/** Google Maps answering geocodes from `places` (an Error is thrown) and every route as 15 minutes, unless `routes` is an Error to throw. */
export function fakeMaps(places: Readonly<Record<string, Geocoded | Error>> = PLACES, o: { routes?: Error } = {}) {
  const geocoded: string[] = [];
  const maps: MapsClient = {
    async geocode(address) {
      geocoded.push(address);
      const found = places[address];
      if (found instanceof Error) throw found;
      return found ?? null;
    },
    async routeMinutes(origins, destinations) {
      if (o.routes) throw o.routes;
      return { minutes: origins.map(() => destinations.map(() => 15)), requestedElements: origins.length * destinations.length };
    },
  };
  return { maps, geocoded };
}

/** A database whose one select (the AI-bookings read) answers these stored `ai_calls.appointment` values. */
export function fakeBookedDb(appointments: readonly unknown[] = []): { db: Db; reads: () => number } {
  let reads = 0;
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => appointments.map((appointment) => ({ appointment })),
  };
  const db = {
    select: () => {
      reads += 1;
      return chain;
    },
  };
  return { db: db as unknown as Db, reads: () => reads };
}

/** An AI booking as the agent's book_appointment tool stores it. */
export const aiBooking = (specialistSfUserId: string, start: string, end: string, over: Row = {}): Row => ({
  slotId: 'w1', kind: 'walkthrough', start, end, specialistSfUserId, addressConfirmed: true, note: '', bookedAt: '2026-10-19T15:00:00.000Z', ...over,
});
