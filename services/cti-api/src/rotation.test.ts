import { describe, expect, it } from 'vitest';
import { pickRotationNumber } from './rotation.js';

const TODAY = new Date().toISOString().slice(0, 10);

/** Minimal fake of the Drizzle query builder used by pickRotationNumber. */
function fakeDb(rows: unknown[]): Parameters<typeof pickRotationNumber>[0] {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
  } as unknown as Parameters<typeof pickRotationNumber>[0];
}

interface Row {
  e164: string;
  active: boolean;
  health: string;
  dialsToday: number;
  dialsTodayDate: string;
  firstUsedAt: Date | null;
  warmupOverrideCap: number | null;
  lastDialAt: Date | null;
}
const row = (over: Partial<Row>): Row => ({
  e164: '+15550000000',
  active: true,
  health: 'unknown',
  dialsToday: 0,
  dialsTodayDate: TODAY,
  firstUsedAt: null,
  warmupOverrideCap: null,
  lastDialAt: null,
  ...over,
});

describe('pickRotationNumber', () => {
  it('returns null (fail-closed) when the pool is empty — no default-caller fallback', async () => {
    expect(await pickRotationNumber(fakeDb([]), 'org')).toBeNull();
  });

  it('picks the DID with the most remaining warmup room', async () => {
    const rows = [
      row({ e164: '+1A', warmupOverrideCap: 20, dialsToday: 15 }), // room 5
      row({ e164: '+1B', warmupOverrideCap: 50, dialsToday: 10 }), // room 40
    ];
    expect(await pickRotationNumber(fakeDb(rows), 'org')).toBe('+1B');
  });

  it('excludes spam_likely and degraded DIDs', async () => {
    const rows = [
      row({ e164: '+1BAD', health: 'spam_likely', warmupOverrideCap: 80 }),
      row({ e164: '+1DEG', health: 'degraded', warmupOverrideCap: 80 }),
      row({ e164: '+1OK', health: 'unknown', warmupOverrideCap: 80 }),
    ];
    expect(await pickRotationNumber(fakeDb(rows), 'org')).toBe('+1OK');
  });

  it('excludes DIDs that have hit their cap today and returns null when all are capped', async () => {
    const rows = [
      row({ e164: '+1A', warmupOverrideCap: 5, dialsToday: 5 }),
      row({ e164: '+1B', warmupOverrideCap: 20, dialsToday: 20 }),
    ];
    expect(await pickRotationNumber(fakeDb(rows), 'org')).toBeNull();
  });

  it('ignores stale dialsTodayDate (counts today as 0 dials)', async () => {
    const rows = [
      row({ e164: '+1A', warmupOverrideCap: 20, dialsToday: 20, dialsTodayDate: '2000-01-01' }),
    ];
    // Yesterday's 20 dials should not count today → eligible.
    expect(await pickRotationNumber(fakeDb(rows), 'org')).toBe('+1A');
  });

  it('breaks ties on equal room by least-recently-dialed (LRU)', async () => {
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-06-01T00:00:00Z');
    const rows = [
      row({ e164: '+1NEW', warmupOverrideCap: 20, dialsToday: 0, lastDialAt: newer }),
      row({ e164: '+1OLD', warmupOverrideCap: 20, dialsToday: 0, lastDialAt: older }),
    ];
    expect(await pickRotationNumber(fakeDb(rows), 'org')).toBe('+1OLD');
  });
});
