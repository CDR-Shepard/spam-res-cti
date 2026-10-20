/**
 * setAppointment's steps, without a database (store-booking.pg.test.ts runs them against Postgres): the owner's lock, the
 * D-10 conflict read, and the live-row write. A high-priority booking (slot h1) skips only the conflict read.
 */
import { describe, expect, it } from 'vitest';
import type { BookedAppointment } from '@cti/contracts';
import { setAppointment } from './store-booking.js';

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = '22222222-2222-4333-8444-555555555555';
const GRANT = '0058X00000Fsx39QAB';

/** A transaction that records which statements ran: a standing booking in the way (`conflict`), and whether the row is live. */
function recordingDb(opts: { conflict: boolean; live: boolean }) {
  const ran: string[] = [];
  const tx = {
    execute: async () => {
      ran.push('lock');
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            ran.push('conflict');
            return opts.conflict ? [{ id: OTHER }] : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            ran.push('update');
            return opts.live ? [{ id: ID }] : [];
          },
        }),
      }),
    }),
  };
  const db = { transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => fn(tx) };
  return { db: db as never, ran };
}

const SLOT: BookedAppointment = {
  slotId: 'w1', kind: 'walkthrough', start: '2026-10-20T17:00:00.000Z', end: '2026-10-20T18:00:00.000Z',
  specialistSfUserId: GRANT, addressConfirmed: true, note: '', bookedAt: '2026-10-19T17:00:00.000Z',
};
const URGENT: BookedAppointment = { ...SLOT, slotId: 'h1', priority: true, note: 'Urgent: Auction on Friday.' };

describe('setAppointment (D-10)', () => {
  it('a booking from the offered times takes the lock, reads for a conflict, and is refused when one stands', async () => {
    const { db, ran } = recordingDb({ conflict: true, live: true });
    expect(await setAppointment(db, ID, SLOT)).toBe('taken');
    expect(ran).toEqual(['lock', 'conflict']);
  });

  it('a high-priority booking skips only the conflict read: it takes the lock and writes over a standing booking', async () => {
    const { db, ran } = recordingDb({ conflict: true, live: true });
    expect(await setAppointment(db, ID, URGENT)).toBe('booked');
    expect(ran).toEqual(['lock', 'update']);
  });

  it('a high-priority booking on a call that already ended is not_live', async () => {
    const { db, ran } = recordingDb({ conflict: false, live: false });
    expect(await setAppointment(db, ID, URGENT)).toBe('not_live');
    expect(ran).toEqual(['lock', 'update']);
  });

  it.each([
    ['priority on an offered slot id', { ...SLOT, priority: true as const }],
    ['slot h1 without priority', { ...SLOT, slotId: 'h1' }],
  ])('%s is refused before anything runs (only slot h1 is high priority)', async (_label, booking) => {
    const { db, ran } = recordingDb({ conflict: false, live: true });
    await expect(setAppointment(db, ID, booking)).rejects.toThrow(/high-priority/);
    expect(ran).toEqual([]);
  });
});
