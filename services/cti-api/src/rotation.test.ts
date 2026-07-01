import { describe, expect, it } from 'vitest';
import { pickRotationNumber } from './rotation.js';

const TODAY = new Date().toISOString().slice(0, 10);

/**
 * Minimal fake of the Drizzle query builder used by pickRotationNumber. The
 * pool query is `select().from().where()` (awaited → rows); the sticky lookup is
 * `select().from().where().limit()` (→ the sticky row, if any). One shared
 * `where` result serves both: awaiting it yields the pool rows, `.limit()`
 * yields the sticky rows.
 */
function fakeDb(rows: unknown[], stickyE164: string | null = null): Parameters<typeof pickRotationNumber>[0] {
  const whereResult = {
    then: (resolve: (v: unknown) => void) => resolve(rows),
    limit: () => Promise.resolve(stickyE164 ? [{ e164: stickyE164 }] : []),
  };
  return {
    select: () => ({ from: () => ({ where: () => whereResult }) }),
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
    expect(await pickRotationNumber(fakeDb([]), 'org', 'rep1')).toBeNull();
  });

  it('picks the DID with the most remaining warmup room', async () => {
    const rows = [
      row({ e164: '+1A', warmupOverrideCap: 20, dialsToday: 15 }), // room 5
      row({ e164: '+1B', warmupOverrideCap: 50, dialsToday: 10 }), // room 40
    ];
    expect(await pickRotationNumber(fakeDb(rows), 'org', 'rep1')).toBe('+1B');
  });

  it('excludes spam_likely and degraded DIDs', async () => {
    const rows = [
      row({ e164: '+1BAD', health: 'spam_likely', warmupOverrideCap: 80 }),
      row({ e164: '+1DEG', health: 'degraded', warmupOverrideCap: 80 }),
      row({ e164: '+1OK', health: 'unknown', warmupOverrideCap: 80 }),
    ];
    expect(await pickRotationNumber(fakeDb(rows), 'org', 'rep1')).toBe('+1OK');
  });

  it('excludes DIDs that have hit their cap today and returns null when all are capped', async () => {
    const rows = [
      row({ e164: '+1A', warmupOverrideCap: 5, dialsToday: 5 }),
      row({ e164: '+1B', warmupOverrideCap: 20, dialsToday: 20 }),
    ];
    expect(await pickRotationNumber(fakeDb(rows), 'org', 'rep1')).toBeNull();
  });

  it('ignores stale dialsTodayDate (counts today as 0 dials)', async () => {
    const rows = [
      row({ e164: '+1A', warmupOverrideCap: 20, dialsToday: 20, dialsTodayDate: '2000-01-01' }),
    ];
    // Yesterday's 20 dials should not count today → eligible.
    expect(await pickRotationNumber(fakeDb(rows), 'org', 'rep1')).toBe('+1A');
  });

  it('breaks ties on equal room by least-recently-dialed (LRU)', async () => {
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-06-01T00:00:00Z');
    const rows = [
      row({ e164: '+1NEW', warmupOverrideCap: 20, dialsToday: 0, lastDialAt: newer }),
      row({ e164: '+1OLD', warmupOverrideCap: 20, dialsToday: 0, lastDialAt: older }),
    ];
    expect(await pickRotationNumber(fakeDb(rows), 'org', 'rep1')).toBe('+1OLD');
  });

  it('prefers a caller ID whose area code matches the callee (local presence)', async () => {
    const rows = [
      row({ e164: '+16195550101', warmupOverrideCap: 20, dialsToday: 10 }), // SD 619, room 10
      row({ e164: '+12135550101', warmupOverrideCap: 80, dialsToday: 0 }),  // LA 213, room 80
    ];
    // The 213 has far more room, but dialing a 619 callee still picks the 619.
    expect(await pickRotationNumber(fakeDb(rows), 'org', 'rep1', '+16195559999')).toBe('+16195550101');
    // Dialing a 213 callee picks the 213.
    expect(await pickRotationNumber(fakeDb(rows), 'org', 'rep1', '+12135559999')).toBe('+12135550101');
  });

  it('falls back to same-metro when no exact area code matches', async () => {
    const rows = [
      row({ e164: '+18585550101', warmupOverrideCap: 80, dialsToday: 0 }), // SD 858
      row({ e164: '+12135550101', warmupOverrideCap: 80, dialsToday: 0 }), // LA 213
    ];
    // A 619 callee has no 619 DID; 858 is same metro (San Diego) → beats LA.
    expect(await pickRotationNumber(fakeDb(rows), 'org', 'rep1', '+16195559999')).toBe('+18585550101');
  });

  it('load-balances by warmup room WITHIN the matched area', async () => {
    const rows = [
      row({ e164: '+16195550101', warmupOverrideCap: 20, dialsToday: 18 }), // 619, room 2
      row({ e164: '+16195550202', warmupOverrideCap: 20, dialsToday: 2 }),  // 619, room 18
      row({ e164: '+12135550101', warmupOverrideCap: 80, dialsToday: 0 }),  // 213, room 80
    ];
    // Both 619s match the callee's area; pick the 619 with more room, not the 213.
    expect(await pickRotationNumber(fakeDb(rows), 'org', 'rep1', '+16195559999')).toBe('+16195550202');
  });

  it('ignores callee area when no number is passed (unchanged load-balancing)', async () => {
    const rows = [
      row({ e164: '+16195550101', warmupOverrideCap: 20, dialsToday: 15 }), // room 5
      row({ e164: '+12135550101', warmupOverrideCap: 80, dialsToday: 0 }),  // room 80
    ];
    expect(await pickRotationNumber(fakeDb(rows), 'org', 'rep1')).toBe('+12135550101');
  });

  it('reuses the sticky DID for a lead when the rep still owns it and it is eligible', async () => {
    const rows = [
      row({ e164: '+16195550101', warmupOverrideCap: 20, dialsToday: 0 }),
      row({ e164: '+16195550202', warmupOverrideCap: 80, dialsToday: 0 }), // more room; would win area-match
    ];
    // Sticky pins ...0101 even though ...0202 has more warmup room.
    expect(await pickRotationNumber(fakeDb(rows, '+16195550101'), 'org', 'rep1', '+16195559999')).toBe('+16195550101');
  });

  it('ignores a sticky DID the rep no longer owns (falls back to area-match)', async () => {
    const rows = [row({ e164: '+16195550202', warmupOverrideCap: 80, dialsToday: 0 })];
    // Sticky points at a number not in this rep's eligible pool → fall back.
    expect(await pickRotationNumber(fakeDb(rows, '+19998887777'), 'org', 'rep1', '+16195559999')).toBe('+16195550202');
  });

  it('ignores the sticky DID when it is over its warmup cap today (falls back)', async () => {
    const rows = [
      row({ e164: '+16195550101', warmupOverrideCap: 5, dialsToday: 5 }),  // sticky but capped → ineligible
      row({ e164: '+16195550202', warmupOverrideCap: 20, dialsToday: 0 }),
    ];
    expect(await pickRotationNumber(fakeDb(rows, '+16195550101'), 'org', 'rep1', '+16195559999')).toBe('+16195550202');
  });
});
