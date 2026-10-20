/** Final review I3: records created by a conversion keep today's owner, the appointment owner, else the booked rep. */
import { describe, expect, it } from 'vitest';
import type { BookedAppointment } from '@cti/contracts';
import { DEFAULT_AI_CALL_BOOKING } from '../settings.js';
import { fakeSfWrites } from '../test/fake-sf-writes.js';
import { transportError } from '../test/writeback-harness.js';
import { conversionOwner } from './conversion-owner.js';

const GRANT = '0058X00000Fsx39QAB';
const CHANCE = '0055f000005qXn8AAE';
const IDS = { writebackId: 'wb-1', aiCallId: '6f0c2a9e-1b2c-4d5e-8f90-123456789abc' };
const USERS = /^SELECT Id, FirstName, Name, IsActive, TimeZoneSidKey FROM User/;
/** A routed walkthrough with Chance at a made-up house. */
const CHANCE_BOOKING: BookedAppointment = {
  slotId: 'w1',
  kind: 'walkthrough',
  start: '2026-10-21T16:00:00.000Z',
  end: '2026-10-21T17:00:00.000Z',
  specialistSfUserId: CHANCE,
  addressConfirmed: true,
  note: 'Gate code is 4321',
  bookedAt: '2026-10-19T22:10:00.000Z',
  region: 'LA',
};
const booking = (specialists: string[]) => ({ ...DEFAULT_AI_CALL_BOOKING, enabled: true, convertLeads: true, specialists });
const grant = (isActive: boolean) => ({ Id: GRANT, FirstName: 'Grant', Name: 'Grant Golden', IsActive: isActive, TimeZoneSidKey: 'America/Los_Angeles' });

function recorder() {
  const warns: Array<[unknown, string | undefined]> = [];
  return { warns, log: { warn: (o: unknown, m?: string) => void warns.push([o, m]) } };
}

describe('conversionOwner', () => {
  it('a booking routed to Chance: the appointment owner (Grant, first active on the list) owns what the conversion creates', async () => {
    const f = fakeSfWrites({ queries: [[USERS, [grant(true)]]] });
    const r = recorder();
    expect(await conversionOwner(f.client, { booking: booking([GRANT]), booked: CHANCE_BOOKING, log: r.log, ids: IDS })).toEqual({ sfUserId: GRANT, name: 'Grant Golden', bookedRep: false });
    expect(f.soql[0]).toContain(`'${GRANT}'`);
    expect(r.warns).toEqual([]);
  });

  it.each<[string, string[], Array<Record<string, unknown>>]>([
    ['the appointment owner is inactive', [GRANT], [grant(false)]],
    ['Salesforce does not return the appointment owner', [GRANT], []],
    ['the list is empty (no query at all)', [], []],
  ])('%s: the booked rep (Chance), with a warn of ids only', async (_label, specialists, users) => {
    const f = fakeSfWrites({ queries: [[USERS, users]] });
    const r = recorder();
    expect(await conversionOwner(f.client, { booking: booking(specialists), booked: CHANCE_BOOKING, log: r.log, ids: IDS })).toEqual({ sfUserId: CHANCE, name: null, bookedRep: true });
    expect(r.warns).toHaveLength(1);
    expect(r.warns[0]![0]).toEqual(IDS);
  });

  it('the User read fails: the booked rep (Chance); the warn carries ids and errName only, and nothing throws', async () => {
    const f = fakeSfWrites({ queries: [[USERS, transportError()]] });
    const r = recorder();
    expect(await conversionOwner(f.client, { booking: booking([GRANT]), booked: CHANCE_BOOKING, log: r.log, ids: IDS })).toEqual({ sfUserId: CHANCE, name: null, bookedRep: true });
    expect(r.warns).toHaveLength(1);
    expect(r.warns[0]![0]).toEqual({ ...IDS, errName: 'SalesforceApiError' });
    const said = JSON.stringify(r.warns);
    expect(said).not.toContain('Gate code');
    expect(said).not.toContain('fetch failed');
  });
});
