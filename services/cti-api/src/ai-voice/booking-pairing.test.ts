/** The high-priority pairing both stores check before they write a booking (booking-pairing.ts). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BookedAppointment } from '@cti/contracts';
import { checkPriorityPairing } from './booking-pairing.js';
import { fakeStore } from './testing.js';

const SLOT: BookedAppointment = {
  slotId: 'w1', kind: 'walkthrough', start: '2026-10-20T17:00:00.000Z', end: '2026-10-20T18:00:00.000Z',
  specialistSfUserId: '0058X00000Fsx39QAB', addressConfirmed: true, note: '', bookedAt: '2026-10-19T17:00:00.000Z',
};

describe('checkPriorityPairing', () => {
  it('passes slot h1 marked priority, and an offered slot that is not', () => {
    expect(() => checkPriorityPairing({ ...SLOT, slotId: 'h1', priority: true })).not.toThrow();
    expect(() => checkPriorityPairing(SLOT)).not.toThrow();
  });

  it('refuses priority on an offered slot id, and slot h1 without priority', () => {
    expect(() => checkPriorityPairing({ ...SLOT, priority: true })).toThrow(RangeError);
    expect(() => checkPriorityPairing({ ...SLOT, slotId: 'h1' })).toThrow(/high-priority/);
  });

  it('the fake store checks it too, and never loads the SQL store to do so', async () => {
    const store = fakeStore();
    await store.insert({ id: 'a1', orgId: 'o1', startedBy: 'u1', toE164: '+16195550100', status: 'in_progress' });
    await expect(store.setAppointment('a1', { ...SLOT, slotId: 'h1' })).rejects.toThrow(/high-priority/);
    expect(readFileSync(new URL('./testing.ts', import.meta.url), 'utf8')).not.toMatch(/from '\.\/store-booking\.js'/);
  });
});
