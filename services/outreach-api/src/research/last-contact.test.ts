import { describe, expect, it } from 'vitest';
import { agentPlanTextIssues, ResearchSource } from '@cti/contracts';
import type { ResearchSnapshot } from './snapshot.js';
import { contactWords, lastRealContact, NO_CONTACT } from './last-contact.js';

const NOW = new Date('2026-10-05T19:00:00.000Z'); // noon in Los Angeles
type Item = ResearchSnapshot['activity'][number];

function snap(activity: Item[]): ResearchSnapshot {
  return {
    version: 1,
    sfObject: 'Lead',
    sfRecordId: '00Q000000000000001',
    collectedAt: NOW.toISOString(),
    consent: 'yes',
    records: [],
    activity,
    sources: ResearchSource.options.map((source) => ({ source, status: 'ok' as const, count: 0, truncated: false, note: null })),
    truncated: false,
  };
}

let n = 0;
const task = (at: string, title: string | null, meta: Record<string, string> = { kind: 'Call' }): Item => ({ source: 'task', id: `00T00000000000${++n}`, at, title, body: '', meta });
const event = (at: string, starts: string | undefined, title: string): Item => ({ source: 'event', id: `00U00000000000${++n}`, at, title, body: '', meta: starts ? { starts } : {} });
const email = (at: string, direction: 'inbound' | 'outbound'): Item => ({ source: 'email', id: `02s00000000000${++n}`, at, title: 'Re: the house', body: '', meta: { direction } });

describe('lastRealContact', () => {
  it('a connected call in February wins over a newer "AI call: No answer" task', () => {
    const s = snap([task('2026-09-30T17:00:00.000Z', 'AI call: No answer'), task('2026-02-12T18:00:00.000Z', 'Call with Pat', { kind: 'Call', disposition: 'Connected' })]);
    expect(lastRealContact(s, NOW)).toEqual({ at: new Date('2026-02-12T18:00:00.000Z'), kind: 'call' });
  });

  it('skips a call that left a voicemail or never connected, by title or disposition', () => {
    const s = snap([
      task('2026-09-01T17:00:00.000Z', 'Left voicemail'),
      task('2026-08-01T17:00:00.000Z', 'Call', { kind: 'Call', disposition: 'No Answer' }),
      task('2026-07-01T17:00:00.000Z', 'Call - wrong number'),
      task('2026-06-01T17:00:00.000Z', 'Call', { kind: 'Call', disposition: 'Busy' }),
      task('2026-05-01T17:00:00.000Z', 'Spoke with seller'),
    ]);
    expect(lastRealContact(s, NOW)).toEqual({ at: new Date('2026-05-01T17:00:00.000Z'), kind: 'call' });
  });

  it('skips a task that is not a call', () => {
    expect(lastRealContact(snap([task('2026-09-01T17:00:00.000Z', 'Send comps', { kind: 'Task' }), task('2026-09-02T17:00:00.000Z', 'Email', {})]), NOW)).toBeNull();
  });

  it('an "ai call" task of any case is ours, never contact', () => {
    expect(lastRealContact(snap([task('2026-09-01T17:00:00.000Z', 'ai CALL: qualified callback')]), NOW)).toBeNull();
  });

  it('a future event is skipped; a past Property Consultation counts at its start', () => {
    const s = snap([event('2026-10-01T17:00:00.000Z', '2026-10-09T17:00:00.000Z', 'Walkthrough'), event('2026-03-01T17:00:00.000Z', '2026-03-04T18:00:00.000Z', 'Property Consultation')]);
    expect(lastRealContact(s, NOW)).toEqual({ at: new Date('2026-03-04T18:00:00.000Z'), kind: 'meeting' });
  });

  it('a past event that is not a meeting, or has no start, is skipped', () => {
    expect(lastRealContact(snap([event('2026-03-01T17:00:00.000Z', '2026-03-04T18:00:00.000Z', 'Send contract'), event('2026-03-01T17:00:00.000Z', undefined, 'Meeting')]), NOW)).toBeNull();
  });

  it('inbound email counts; outbound does not', () => {
    expect(lastRealContact(snap([email('2026-09-20T17:00:00.000Z', 'outbound'), email('2026-04-20T17:00:00.000Z', 'inbound')]), NOW)).toEqual({ at: new Date('2026-04-20T17:00:00.000Z'), kind: 'email' });
  });

  it('notes and chatter are not two-way contact', () => {
    const note: Item = { source: 'note', id: '00200000000001', at: '2026-09-20T17:00:00.000Z', title: 'Spoke with Pat', body: '', meta: {} };
    const chatter: Item = { source: 'chatter', id: '0D500000000001', at: '2026-09-21T17:00:00.000Z', title: null, body: 'Called her', meta: {} };
    expect(lastRealContact(snap([note, chatter]), NOW)).toBeNull();
  });

  it('the newest of call, meeting and email wins', () => {
    const s = snap([task('2026-02-12T18:00:00.000Z', 'Call'), event('2026-01-01T00:00:00.000Z', '2026-06-01T18:00:00.000Z', 'Appointment'), email('2026-04-20T17:00:00.000Z', 'inbound')]);
    expect(lastRealContact(s, NOW)).toEqual({ at: new Date('2026-06-01T18:00:00.000Z'), kind: 'meeting' });
  });

  it('an empty snapshot gives null', () => {
    expect(lastRealContact(snap([]), NOW)).toBeNull();
  });

  it('NO_CONTACT is the brief pattern', () => {
    for (const s of ['No Answer', 'left a message', 'Left VM', 'vm', 'Disconnected', 'not in service', 'Did not connect', 'Unreachable', 'no contact']) expect(NO_CONTACT.test(s)).toBe(true);
    for (const s of ['Connected', 'Spoke with seller', 'Vmware']) expect(NO_CONTACT.test(s)).toBe(false);
  });
});

describe('contactWords', () => {
  const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
  it.each<[number, string]>([
    [0, 'earlier this week'],
    [6, 'earlier this week'],
    [7, 'last week'],
    [13, 'last week'],
    [14, 'back in September'],
    [236, 'back in February'],
    [329, 'back in November'],
    [330, 'about a year ago'],
    [547, 'about a year ago'],
    [548, 'about two years ago'],
    [912, 'about two years ago'],
    [913, 'a few years ago'],
    [4_000, 'a few years ago'],
  ])('%i days ago reads "%s"', (days, words) => {
    expect(contactWords(daysAgo(days), NOW)).toBe(words);
  });

  it('counts whole days in the time zone, not 24-hour spans', () => {
    // 2026-09-28 23:30 in Los Angeles is 7 calendar days before 2026-10-05, though only six and a half 24-hour spans.
    expect(contactWords(new Date('2026-09-29T06:30:00.000Z'), NOW)).toBe('last week');
    // The same instant is already 2026-09-29 in New York: six days.
    expect(contactWords(new Date('2026-09-29T06:30:00.000Z'), NOW, 'America/New_York')).toBe('earlier this week');
  });

  it('names the month in the time zone', () => {
    // 2026-03-01 03:00 UTC is still February 28 in Los Angeles.
    expect(contactWords(new Date('2026-03-01T03:00:00.000Z'), NOW)).toBe('back in February');
    expect(contactWords(new Date('2026-03-01T03:00:00.000Z'), NOW, 'UTC')).toBe('back in March');
  });

  it('every result is letters and spaces only and passes the agent plan text check', () => {
    for (let d = 0; d <= 1_200; d += 1) {
      const words = contactWords(daysAgo(d), NOW);
      expect(words).toMatch(/^[A-Za-z ]+$/);
      expect(agentPlanTextIssues(words, { singleLine: true })).toEqual([]);
    }
  });
});
