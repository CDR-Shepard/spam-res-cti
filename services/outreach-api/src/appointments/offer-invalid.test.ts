/** An offer whose slots fail the slot contract has its own note: what goes into the signed trigger must parse there. */
import { describe, expect, it, vi } from 'vitest';
import type { AiCallBookingSettings } from '@cti/contracts';
import { DEFAULT_AI_CALL_BOOKING, DEFAULT_BOOKING_ROUTING } from '../settings.js';
import { fakeBookedDb, fakeMaps, GRANT, offerSalesforce, SD_CITY_ONLY, SD_PROPERTY } from '../test/fake-offer.js';
import { readOfferCalendars, routedOffer } from './offer.js';

vi.mock('./routing.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./routing.js')>();
  return {
    ...original,
    // A slot id the contract refuses (p0): what a future bug in the routing engine would produce.
    phoneSlots: (...args: Parameters<typeof original.phoneSlots>) => original.phoneSlots(...args).map((s) => ({ ...s, id: s.id.replace(/\d$/, '0') })),
  };
});

const ORG = '00000000-0000-4000-8000-0000000000a2';
const NOW = new Date('2026-10-19T16:00:00Z');
const booking: AiCallBookingSettings = { ...structuredClone(DEFAULT_AI_CALL_BOOKING), enabled: true, specialists: [GRANT], routing: structuredClone(DEFAULT_BOOKING_ROUTING) };

async function offerFor(address: string) {
  const cal = await readOfferCalendars(offerSalesforce().client, { booking, now: NOW });
  const deps = { db: fakeBookedDb().db, maps: fakeMaps().maps, log: { info: vi.fn(), warn: vi.fn() } };
  return routedOffer(deps, cal, { orgId: ORG, booking, now: NOW, address, consultations: null });
}

describe('routedOffer: slots the contract refuses', () => {
  it('give invalid_slots and no slots', async () => {
    expect(await offerFor(SD_CITY_ONLY)).toEqual({ slots: [], priority: null, region: 'SD', ownerSfUserId: null, note: 'invalid_slots' });
  });

  it('keep the high-priority offer, which does not depend on them', async () => {
    const offer = await offerFor(SD_PROPERTY);
    expect(offer).toMatchObject({ slots: [], region: 'SD', ownerSfUserId: GRANT, note: 'invalid_slots' });
    expect(offer.priority?.specialistSfUserId).toBe(GRANT);
  });
});
