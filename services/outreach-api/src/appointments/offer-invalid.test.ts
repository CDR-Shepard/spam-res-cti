/** Fix 1 (M-6): an offer that fails the slot contract has its own note, not salesforce_error. */
import { describe, expect, it, vi } from 'vitest';
import type { AiCallBookingSettings } from '@cti/contracts';
import { DEFAULT_AI_CALL_BOOKING } from '../settings.js';
import { fakeSalesforce } from '../test/fake-sf-client.js';
import { offerSlots } from './offer.js';

vi.mock('./slots.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./slots.js')>();
  return {
    ...original,
    // A slot whose id the contract refuses (p0): what a future bug in toSlots would produce.
    toSlots: (...args: Parameters<typeof original.toSlots>) => original.toSlots(...args).map((s) => ({ ...s, id: s.id.replace(/\d$/, '0') })),
  };
});

const GRANT = '0058X00000Fsx39QAB';

describe('offerSlots: slots the contract refuses', () => {
  it('give invalid_slots with the owner named, and no slots', async () => {
    const booking: AiCallBookingSettings = { ...structuredClone(DEFAULT_AI_CALL_BOOKING), specialists: [GRANT] };
    const sf = fakeSalesforce({
      queries: [
        [/FROM User/, [{ Id: GRANT, FirstName: 'Grant', Name: 'Grant Golden', IsActive: true, TimeZoneSidKey: 'America/Los_Angeles' }]],
        [/FROM Event/, []],
      ],
    });
    expect(await offerSlots(sf.client, { booking, now: new Date('2026-10-06T15:00:00.000Z') })).toEqual({ slots: [], ownerSfUserId: GRANT, note: 'invalid_slots' });
  });
});
