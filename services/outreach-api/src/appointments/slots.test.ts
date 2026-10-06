import { describe, expect, it } from 'vitest';
import { AppointmentSlots } from '@cti/contracts';
import { DEFAULT_AI_CALL_BOOKING } from '../settings.js';
import { conflicts, freeWindows, pickOffered, toSlots, type Busy, type KindRules, type Window } from './slots.js';
import { zonedInstant } from './zoned.js';

const LA = 'America/Los_Angeles';
const WEEKDAYS = [1, 2, 3, 4, 5] as const;
const PHONE: KindRules = DEFAULT_AI_CALL_BOOKING.phone;
const WALK: KindRules = DEFAULT_AI_CALL_BOOKING.walkthrough;
/** Tuesday 2026-10-06 08:00 PDT. */
const NOW = new Date('2026-10-06T15:00:00.000Z');
const MIN = 60_000;

/** A local wall-clock instant in LA. */
const la = (m: number, d: number, hh: number, mm = 0, y = 2026): Date => zonedInstant(LA, y, m, d, hh, mm);
/** "m/d hh:mm" in LA for each window start: readable expectations. */
const starts = (ws: readonly Window[]): string[] =>
  ws.map((w) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: LA, hourCycle: 'h23', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).formatToParts(w.start);
    const v = (t: string) => p.find((x) => x.type === t)!.value;
    return `${v('month')}/${v('day')} ${v('hour')}:${v('minute')}`;
  });
const timed = (start: Date, end: Date): Busy => ({ start, end, allDay: false });
const allDay = (y: number, m: number, d: number): Busy => ({ start: new Date(Date.UTC(y, m - 1, d)), end: new Date(Date.UTC(y, m - 1, d + 1)), allDay: true, day: { year: y, month: m, day: d } });
const halfHours = (from: number, toInclusive: number): string[] => {
  const out: string[] = [];
  for (let m = from * 60; m <= toInclusive * 60; m += 30) out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${m % 60 === 0 ? '00' : '30'}`);
  return out;
};

describe('freeWindows', () => {
  it('1: phone defaults, no busy time: today from 10:00 (2 h lead) to 17:30, tomorrow all day, nothing on Thursday', () => {
    const ws = freeWindows(PHONE, WEEKDAYS, [], NOW, LA);
    expect(starts(ws)).toEqual([...halfHours(10, 17.5).map((t) => `10/6 ${t}`), ...halfHours(10, 17.5).map((t) => `10/7 ${t}`)]);
    expect(ws[0]).toEqual({ start: la(10, 6, 10), end: la(10, 6, 10, 15) });
    expect(ws.every((w) => w.end.getTime() - w.start.getTime() === 15 * MIN)).toBe(true);
  });

  it('the lead time is inclusive: a start exactly at now + lead is kept, one a minute earlier is not', () => {
    expect(starts(freeWindows(PHONE, WEEKDAYS, [], la(10, 6, 9, 30), LA))[0]).toBe('10/6 11:30');
    expect(starts(freeWindows(PHONE, WEEKDAYS, [], la(10, 6, 9, 31), LA))[0]).toBe('10/6 12:00');
    expect(starts(freeWindows(PHONE, WEEKDAYS, [], la(10, 6, 8, 1), LA))[0]).toBe('10/6 10:30');
  });

  it('late in the day: today has nothing left, tomorrow is still the second horizon day', () => {
    const ws = freeWindows(PHONE, WEEKDAYS, [], la(10, 6, 16, 0), LA);
    expect(starts(ws)).toEqual(halfHours(10, 17.5).map((t) => `10/7 ${t}`));
  });

  it('2: walkthrough defaults: today is excluded (20 h lead); Wed 9:00 … 16:00; through Mon 10/12, skipping the weekend', () => {
    const ws = freeWindows(WALK, WEEKDAYS, [], NOW, LA);
    const hours = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'];
    expect(starts(ws)).toEqual(['10/7', '10/8', '10/9', '10/12'].flatMap((d) => hours.map((h) => `${d} ${h}`)));
    expect(ws.at(-1)).toEqual({ start: la(10, 12, 16), end: la(10, 12, 17) });
  });

  it('the walkthrough lead time edge: 20 h ahead to the minute', () => {
    expect(starts(freeWindows(WALK, WEEKDAYS, [], la(10, 6, 13, 0), LA))[0]).toBe('10/7 09:00');
    expect(starts(freeWindows(WALK, WEEKDAYS, [], la(10, 6, 13, 1), LA))[0]).toBe('10/7 10:00');
  });

  it('3: a busy 11:00–12:00 Wed with a 30 min buffer: no walkthrough at 10, 11 or 12; 9 and 13 remain', () => {
    const ws = starts(freeWindows(WALK, WEEKDAYS, [timed(la(10, 7, 11), la(10, 7, 12))], NOW, LA)).filter((s) => s.startsWith('10/7 '));
    expect(ws).toEqual(['10/7 09:00', '10/7 13:00', '10/7 14:00', '10/7 15:00', '10/7 16:00']);
  });

  it('the buffer applies on both sides and touching the buffered edge is free', () => {
    // A 30 min buffer around a 10:00–11:00 walkthrough is 9:30–11:30: a busy 11:30–12:00 only touches it.
    const ws = starts(freeWindows(WALK, WEEKDAYS, [timed(la(10, 7, 11, 30), la(10, 7, 12))], NOW, LA)).filter((s) => s.startsWith('10/7 '));
    expect(ws).toEqual(['10/7 09:00', '10/7 10:00', '10/7 13:00', '10/7 14:00', '10/7 15:00', '10/7 16:00']);
    // A busy 8:00–8:30 ends exactly where the 9:00 window's buffer starts.
    expect(starts(freeWindows(WALK, WEEKDAYS, [timed(la(10, 7, 8), la(10, 7, 8, 30))], NOW, LA))[0]).toBe('10/7 09:00');
    // A busy 8:00–8:31 reaches into it.
    expect(starts(freeWindows(WALK, WEEKDAYS, [timed(la(10, 7, 8), la(10, 7, 8, 31))], NOW, LA))[0]).toBe('10/7 10:00');
  });

  it('4: an all-day event on Wednesday blocks every Wednesday window, and only Wednesday', () => {
    const ws = starts(freeWindows(WALK, WEEKDAYS, [allDay(2026, 10, 7)], NOW, LA));
    expect(ws.some((s) => s.startsWith('10/7 '))).toBe(false);
    expect(ws.filter((s) => s.startsWith('10/8 '))).toHaveLength(8);
    expect(ws.filter((s) => s.startsWith('10/6 '))).toHaveLength(0);
  });

  it('an all-day event is the local day, whatever its UTC instants say', () => {
    // Salesforce gives an all-day Wednesday as midnight GMT, which is Tuesday evening in LA: only Wednesday is blocked.
    const ws = starts(freeWindows(PHONE, WEEKDAYS, [allDay(2026, 10, 7)], NOW, LA));
    expect(ws).toEqual(halfHours(10, 17.5).map((t) => `10/6 ${t}`));
  });

  it('5: a phone busy 10:10–10:30: 10:00 dropped (it overlaps), 10:30 kept (it only touches)', () => {
    const ws = starts(freeWindows(PHONE, WEEKDAYS, [timed(la(10, 6, 10, 10), la(10, 6, 10, 30))], NOW, LA));
    expect(ws.slice(0, 2)).toEqual(['10/6 10:30', '10/6 11:00']);
  });

  it('5b: a phone busy 10:15–10:30 touches 10:00–10:15 and 10:30–10:45 on either side: both kept (no buffer)', () => {
    const ws = starts(freeWindows(PHONE, WEEKDAYS, [timed(la(10, 6, 10, 15), la(10, 6, 10, 30))], NOW, LA));
    expect(ws.slice(0, 2)).toEqual(['10/6 10:00', '10/6 10:30']);
  });

  it('a busy event spanning days blocks the end of one day and the start of the next', () => {
    const ws = starts(freeWindows(WALK, WEEKDAYS, [timed(la(10, 7, 14, 30), la(10, 8, 10))], NOW, LA));
    // Wednesday: 13:00 ends 14:00, and its buffer ends exactly where the busy time starts (touching), so it stays.
    expect(ws.filter((s) => s.startsWith('10/7 '))).toEqual(['10/7 09:00', '10/7 10:00', '10/7 11:00', '10/7 12:00', '10/7 13:00']);
    // Thursday: 9:00 and 10:00 (its buffer starts 9:30) are blocked; 11:00 is free.
    expect(ws.filter((s) => s.startsWith('10/8 '))[0]).toBe('10/8 11:00');
  });

  it('a busy event covering the whole horizon leaves nothing; unsorted busy input works', () => {
    expect(freeWindows(WALK, WEEKDAYS, [timed(la(10, 5, 0), la(10, 20, 0))], NOW, LA)).toEqual([]);
    const busy = [timed(la(10, 7, 15), la(10, 7, 16)), timed(la(10, 7, 9), la(10, 7, 10))];
    const ws = starts(freeWindows(PHONE, WEEKDAYS, busy, NOW, LA)).filter((s) => s.startsWith('10/7 '));
    expect(ws).toContain('10/7 14:30');
    expect(ws).not.toContain('10/7 15:00');
    expect(ws).not.toContain('10/7 15:30');
    expect(ws).toContain('10/7 16:00');
    expect(ws).toContain('10/7 10:00');
  });

  it('from a Saturday the horizon starts on Monday', () => {
    const ws = starts(freeWindows(PHONE, WEEKDAYS, [], la(10, 10, 9), LA));
    expect([...new Set(ws.map((s) => s.split(' ')[0]))]).toEqual(['10/12', '10/13']);
  });

  it('the horizon counts only the configured days', () => {
    const rules = { ...WALK, horizonBusinessDays: 3, minLeadMinutes: 0 };
    const ws = starts(freeWindows(rules, [1, 3, 5], [], NOW, LA));
    expect([...new Set(ws.map((s) => s.split(' ')[0]))]).toEqual(['10/7', '10/9', '10/12']);
    const sat = starts(freeWindows({ ...rules, horizonBusinessDays: 1 }, [6], [], NOW, LA));
    expect([...new Set(sat.map((s) => s.split(' ')[0]))]).toEqual(['10/10']);
  });

  it('today counts toward the horizon even when its windows are all past', () => {
    const ws = starts(freeWindows({ ...PHONE, horizonBusinessDays: 1 }, WEEKDAYS, [], la(10, 6, 17, 0), LA));
    expect(ws).toEqual([]);
  });

  it('a start is kept only while it ends by endHour; a step that does not divide the day evenly', () => {
    const rules = { ...PHONE, durationMinutes: 45, stepMinutes: 60 as const, startHour: 9, endHour: 12, minLeadMinutes: 0, horizonBusinessDays: 1 };
    expect(starts(freeWindows(rules, WEEKDAYS, [], la(10, 6, 0), LA))).toEqual(['10/6 09:00', '10/6 10:00', '10/6 11:00']);
    const long = { ...rules, durationMinutes: 61 };
    expect(starts(freeWindows(long, WEEKDAYS, [], la(10, 6, 0), LA))).toEqual(['10/6 09:00', '10/6 10:00']);
    const quarter = { ...rules, durationMinutes: 30, stepMinutes: 15 as const, startHour: 9, endHour: 10 };
    expect(starts(freeWindows(quarter, WEEKDAYS, [], la(10, 6, 0), LA))).toEqual(['10/6 09:00', '10/6 09:15', '10/6 09:30']);
  });

  it('a kind that is off offers nothing', () => {
    expect(freeWindows({ ...PHONE, enabled: false }, WEEKDAYS, [], NOW, LA)).toEqual([]);
  });

  it('8: across the fall DST change (now Fri 2026-10-30): Monday 11/2 9:00 is PST, 17:00Z', () => {
    const ws = freeWindows(WALK, WEEKDAYS, [], la(10, 30, 8), LA);
    const monday = ws.filter((w) => starts([w])[0]!.startsWith('11/2 '));
    expect(monday[0]!.start.toISOString()).toBe('2026-11-02T17:00:00.000Z');
    expect(monday[0]!.end.toISOString()).toBe('2026-11-02T18:00:00.000Z');
    expect(starts(ws).filter((s) => s.startsWith('10/30 '))).toEqual([]);
    expect([...new Set(starts(ws).map((s) => s.split(' ')[0]))]).toEqual(['11/2', '11/3', '11/4', '11/5']);
  });

  it('across the spring DST change (now Fri 2027-03-12): Monday 3/15 9:00 is PDT, 16:00Z', () => {
    const ws = freeWindows(WALK, WEEKDAYS, [], la(3, 12, 8, 0, 2027), LA);
    expect(ws[0]!.start.toISOString()).toBe('2027-03-15T16:00:00.000Z');
    expect(ws.filter((w) => w.start.toISOString().startsWith('2027-03-15')).map((w) => w.start.getUTCHours())).toEqual([16, 17, 18, 19, 20, 21, 22, 23]);
  });

  it('a weekend DST change does not shift the hours of either side', () => {
    const ws = freeWindows({ ...PHONE, horizonBusinessDays: 2 }, WEEKDAYS, [], la(10, 30, 8), LA);
    expect(ws.filter((w) => w.start.toISOString().startsWith('2026-10-30'))[0]!.start.toISOString()).toBe('2026-10-30T17:00:00.000Z');
    expect(ws.filter((w) => w.start.toISOString().startsWith('2026-11-02'))[0]!.start.toISOString()).toBe('2026-11-02T18:00:00.000Z');
  });

  it('business hours are in the zone given (the specialist\'s), not the server\'s', () => {
    const ny = freeWindows({ ...PHONE, horizonBusinessDays: 1, minLeadMinutes: 0 }, WEEKDAYS, [], new Date('2026-10-06T12:00:00Z'), 'America/New_York');
    expect(ny[0]!.start.toISOString()).toBe('2026-10-06T14:00:00.000Z');
  });
});

describe('pickOffered', () => {
  const walk = freeWindows(WALK, WEEKDAYS, [], NOW, LA);

  it('6: max 6 over the walkthrough horizon: at most 2 a day, a morning and an afternoon each day, ascending', () => {
    const picked = pickOffered(walk, 6, LA);
    expect(starts(picked)).toEqual(['10/7 09:00', '10/7 12:00', '10/8 09:00', '10/8 12:00', '10/9 09:00', '10/9 12:00']);
    expect(picked.map((w) => w.start.getTime())).toEqual([...picked.map((w) => w.start.getTime())].sort((a, b) => a - b));
  });

  it('a day with only mornings, or only afternoons, gives its first two', () => {
    const mornings = walk.filter((w) => starts([w])[0]!.startsWith('10/7 ') && w.start < la(10, 7, 12));
    expect(starts(pickOffered(mornings, 6, LA))).toEqual(['10/7 09:00', '10/7 10:00']);
    const afternoons = walk.filter((w) => w.start >= la(10, 8, 13) && w.start < la(10, 9, 0));
    expect(starts(pickOffered(afternoons, 6, LA))).toEqual(['10/8 13:00', '10/8 14:00']);
  });

  it('a day with one window gives it alone; fewer windows than max gives them all', () => {
    const one = [walk[0]!, walk.find((w) => w.start >= la(10, 8, 15))!];
    expect(starts(pickOffered(one, 6, LA))).toEqual(['10/7 09:00', '10/8 15:00']);
    expect(pickOffered([], 6, LA)).toEqual([]);
  });

  it('max cuts the list (odd max takes the first window of the last day)', () => {
    expect(starts(pickOffered(walk, 3, LA))).toEqual(['10/7 09:00', '10/7 12:00', '10/8 09:00']);
    expect(pickOffered(walk, 0, LA)).toEqual([]);
  });

  it('the day is the local day: a late-evening window is not grouped with the next UTC day', () => {
    const ws: Window[] = [
      { start: la(10, 7, 15), end: la(10, 7, 16) },
      { start: la(10, 7, 16), end: la(10, 7, 17) },
      { start: la(10, 7, 17, 30), end: la(10, 7, 18) },
      { start: la(10, 8, 9), end: la(10, 8, 10) },
    ];
    // 17:30 PDT is already Thursday in UTC; grouped by the UTC day it would wrongly be offered as Thursday's afternoon.
    expect(starts(pickOffered(ws, 6, LA))).toEqual(['10/7 15:00', '10/7 16:00', '10/8 09:00']);
  });

  it('never changes its input', () => {
    const copy = walk.map((w) => ({ ...w }));
    pickOffered(walk, 6, LA);
    expect(walk).toEqual(copy);
  });
});

describe('toSlots', () => {
  const grant = { sfUserId: '0058X00000Fsx39QAB', firstName: 'Grant', timeZone: LA };

  it('7: ids w1..w6 in order, ISO instants, the specialist\'s zone; parses with AppointmentSlots', () => {
    const picked = pickOffered(freeWindows(WALK, WEEKDAYS, [], NOW, LA), 6, LA);
    const slots = toSlots('walkthrough', picked, grant);
    expect(slots.map((s) => s.id)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5', 'w6']);
    expect(slots[0]).toEqual({
      id: 'w1',
      kind: 'walkthrough',
      start: '2026-10-07T16:00:00.000Z',
      end: '2026-10-07T17:00:00.000Z',
      specialistSfUserId: grant.sfUserId,
      specialistFirstName: 'Grant',
      timeZone: LA,
    });
    expect(AppointmentSlots.safeParse(slots).success).toBe(true);
  });

  it('phone slots are p1…, a null first name stays null, and phone + walkthrough together still parse', () => {
    const phone = toSlots('phone', pickOffered(freeWindows(PHONE, WEEKDAYS, [], NOW, LA), 6, LA), { ...grant, firstName: null });
    expect(phone.map((s) => s.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(phone.every((s) => s.specialistFirstName === null && s.kind === 'phone')).toBe(true);
    const walk = toSlots('walkthrough', pickOffered(freeWindows(WALK, WEEKDAYS, [], NOW, LA), 6, LA), grant);
    expect(AppointmentSlots.safeParse([...phone, ...walk]).success).toBe(true);
  });

  it('Part 4 Fix 1 (I-3): with a buffer each slot carries the time it blocks (the same widening conflicts() uses); with none, no block', () => {
    const picked = pickOffered(freeWindows(WALK, WEEKDAYS, [], NOW, LA), 6, LA);
    const [w1] = toSlots('walkthrough', picked, grant, 30 * MIN);
    expect(w1).toMatchObject({ start: '2026-10-07T16:00:00.000Z', end: '2026-10-07T17:00:00.000Z', blockStart: '2026-10-07T15:30:00.000Z', blockEnd: '2026-10-07T17:30:00.000Z' });
    const [p1] = toSlots('phone', pickOffered(freeWindows(PHONE, WEEKDAYS, [], NOW, LA), 6, LA), grant, 0);
    expect(p1).not.toHaveProperty('blockStart');
    expect(p1).not.toHaveProperty('blockEnd');
    expect(AppointmentSlots.safeParse([p1, w1]).success).toBe(true);
  });

  it('never makes an id the contract refuses: at most nine of a kind', () => {
    const many: Window[] = Array.from({ length: 12 }, (_, i) => ({ start: new Date(NOW.getTime() + i * 60 * MIN), end: new Date(NOW.getTime() + (i * 60 + 15) * MIN) }));
    expect(toSlots('phone', many, grant).map((s) => s.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']);
  });
});

describe('conflicts (Fix 1, I-1: the one rule freeWindows uses; Part 5b re-checks a booking with it)', () => {
  const w = (start: Date, minutes: number): Window => ({ start, end: new Date(start.getTime() + minutes * MIN) });
  const BUF = 30 * MIN;

  it.each<[string, Window, Busy[], number, boolean]>([
    ['touching on the left is free', w(la(10, 7, 10), 15), [timed(la(10, 7, 9, 45), la(10, 7, 10))], 0, false],
    ['touching on the right is free', w(la(10, 7, 10), 15), [timed(la(10, 7, 10, 15), la(10, 7, 10, 30))], 0, false],
    ['a one-minute overlap conflicts', w(la(10, 7, 10), 15), [timed(la(10, 7, 10, 14), la(10, 7, 10, 30))], 0, true],
    ['busy inside the window conflicts', w(la(10, 7, 9), 60), [timed(la(10, 7, 9, 20), la(10, 7, 9, 40))], 0, true],
    ['the buffer turns a near miss into a conflict', w(la(10, 7, 10), 60), [timed(la(10, 7, 11, 15), la(10, 7, 12))], BUF, true],
    ['touching the buffered edge is free', w(la(10, 7, 10), 60), [timed(la(10, 7, 11, 30), la(10, 7, 12))], BUF, false],
    ['an all-day Event conflicts on its local date', w(la(10, 7, 23), 30), [allDay(2026, 10, 7)], 0, true],
    ['an all-day Event is never widened by the buffer', w(la(10, 8, 0, 30), 30), [allDay(2026, 10, 7)], 120 * MIN, false],
    ['a window across midnight touches both local dates', w(la(10, 6, 23, 30), 60), [allDay(2026, 10, 7)], 0, true],
    ['an all-day item without a day is judged by its instants', w(la(10, 7, 10), 60), [{ start: la(10, 7, 10, 30), end: la(10, 7, 11), allDay: true }], 0, true],
  ])('%s', (_label, window, busy, buffer, expected) => {
    expect(conflicts(window, busy, LA, buffer)).toBe(expected);
  });

  it('agrees with freeWindows on every candidate (touching, overlapping, buffered, all-day)', () => {
    const anyLead: KindRules = { ...WALK, minLeadMinutes: 0 };
    const phoneAnyLead: KindRules = { ...PHONE, minLeadMinutes: 0, horizonBusinessDays: 5 };
    const busySets: Busy[][] = [
      [timed(la(10, 7, 11), la(10, 7, 12))],
      [timed(la(10, 7, 10, 15), la(10, 7, 10, 30)), timed(la(10, 8, 13, 59), la(10, 8, 14, 1))],
      [allDay(2026, 10, 8), timed(la(10, 9, 8, 30), la(10, 9, 9))],
      [timed(la(10, 6, 20), la(10, 7, 10, 20))],
    ];
    for (const rules of [anyLead, phoneAnyLead]) {
      const all = freeWindows(rules, WEEKDAYS, [], NOW, LA);
      for (const busy of busySets) {
        const kept = all.filter((x) => !conflicts(x, busy, LA, rules.bufferMinutes * MIN));
        expect(freeWindows(rules, WEEKDAYS, busy, NOW, LA)).toEqual(kept);
        expect(kept.length).toBeLessThan(all.length);
      }
    }
  });
});
