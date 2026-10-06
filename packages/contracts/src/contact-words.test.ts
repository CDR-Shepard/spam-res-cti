import { describe, expect, it } from 'vitest';
import { agentPlanTextIssues } from './agent-plan-text.js';
import { Reengagement } from './call-plans.js';
import { contactLabel, contactSearchLimited, contactWords, lastContactWordsAt, NO_CONTACT_IN_RECENT_ACTIVITY } from './contact-words.js';

const NOW = new Date('2026-10-05T19:00:00.000Z'); // noon in Los Angeles
const daysAgo = (d: number, now = NOW) => new Date(now.getTime() - d * 86_400_000);

describe('contactWords', () => {
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

  describe('Fix 1 (M-6): two weeks or more ago, in the current month', () => {
    const LATE = new Date('2026-10-28T19:00:00.000Z');
    it.each<[number, string]>([
      [13, 'last week'],
      [14, 'earlier this month'],
      [27, 'earlier this month'],
      [28, 'back in September'],
    ])('%i days before October 28th reads "%s"', (days, words) => {
      expect(contactWords(daysAgo(days, LATE), LATE)).toBe(words);
    });
    it('never says "back in October" in October', () => {
      for (let d = 0; d <= 40; d += 1) expect(contactWords(daysAgo(d, LATE), LATE)).not.toBe('back in October');
    });
    it('reads the month in the time zone', () => {
      // November 1st 05:00 UTC is still October 31st in Los Angeles: 17 days after October 14th, same month there.
      const now = new Date('2026-11-01T05:00:00.000Z');
      expect(contactWords(new Date('2026-10-14T19:00:00.000Z'), now)).toBe('earlier this month');
      expect(contactWords(new Date('2026-10-14T19:00:00.000Z'), now, 'UTC')).toBe('back in October');
    });
  });

  it('counts whole days in the time zone, not 24-hour spans', () => {
    expect(contactWords(new Date('2026-09-29T06:30:00.000Z'), NOW)).toBe('last week');
    expect(contactWords(new Date('2026-09-29T06:30:00.000Z'), NOW, 'America/New_York')).toBe('earlier this week');
  });

  it('every result is letters and spaces only and passes the agent plan text check', () => {
    for (const now of [NOW, new Date('2026-10-28T19:00:00.000Z'), new Date('2027-01-02T19:00:00.000Z')]) {
      for (let d = 0; d <= 1_200; d += 1) {
        const words = contactWords(daysAgo(d, now), now);
        expect(words).toMatch(/^[A-Za-z ]+$/);
        expect(agentPlanTextIssues(words, { singleLine: true })).toEqual([]);
      }
    }
    expect(agentPlanTextIssues(NO_CONTACT_IN_RECENT_ACTIVITY, { singleLine: true })).toEqual([]);
  });
});

describe('contactLabel (Fix 1, M-5)', () => {
  it.each<[Parameters<typeof contactLabel>[0], string]>([
    ['call', 'Last time we spoke'],
    ['meeting', 'Last time we spoke'],
    ['email', 'Last email from them'],
    [null, 'Last time we spoke'],
    [undefined, 'Last time we spoke'],
  ])('%s reads "%s"', (kind, label) => {
    expect(contactLabel(kind)).toBe(label);
  });
});

describe('lastContactWordsAt (Fix 1, M-4): the words are worked out when the plan is read', () => {
  it('prefers the stored date, relative to the time of reading', () => {
    const r = { lastContact: 'earlier this week', lastContactAt: '2026-10-01T17:00:00.000Z' };
    expect(lastContactWordsAt(r, NOW)).toBe('earlier this week');
    expect(lastContactWordsAt(r, new Date('2026-10-22T19:00:00.000Z'))).toBe('earlier this month');
    expect(lastContactWordsAt(r, new Date('2026-11-20T19:00:00.000Z'))).toBe('back in October');
  });
  it('an old plan with no date keeps its stored words', () => {
    expect(lastContactWordsAt({ lastContact: 'back in February' }, NOW)).toBe('back in February');
    expect(lastContactWordsAt({ lastContact: 'back in February', lastContactAt: null }, NOW)).toBe('back in February');
  });
  it('no contact: null', () => {
    expect(lastContactWordsAt(null, NOW)).toBeNull();
    expect(lastContactWordsAt({ lastContact: null }, NOW)).toBeNull();
  });
  it('an unreadable date falls back to the stored words', () => {
    expect(lastContactWordsAt({ lastContact: 'last week', lastContactAt: 'soon' }, NOW)).toBe('last week');
  });
});

describe('Reengagement carries the date and kind (Fix 1, M-4)', () => {
  it('parses with and without them', () => {
    expect(Reengagement.parse({ lastContact: 'last week', lastTopic: null })).toEqual({ lastContact: 'last week', lastTopic: null });
    const full = { lastContact: 'last week', lastContactAt: '2026-09-28T17:00:00.000Z', lastContactKind: 'email', lastTopic: 'the move' };
    expect(Reengagement.parse(full)).toEqual(full);
  });
  it('refuses a date that is not an ISO timestamp and a kind it does not know', () => {
    expect(Reengagement.safeParse({ lastContact: 'last week', lastContactAt: 'last Tuesday', lastTopic: null }).success).toBe(false);
    expect(Reengagement.safeParse({ lastContact: 'last week', lastContactKind: 'text', lastTopic: null }).success).toBe(false);
  });
});

describe('contactSearchLimited (sweep D-13: one rule for the plan facts and the card)', () => {
  const src = (source: string, truncated: boolean) => ({ source, truncated });
  it('is true only when research cut the tasks, events or emails short', () => {
    expect(contactSearchLimited([src('tasks', true)])).toBe(true);
    expect(contactSearchLimited([src('events', false), src('emails', true)])).toBe(true);
    expect(contactSearchLimited([src('chatter', true), src('notes', true), src('tasks', false)])).toBe(false);
    expect(contactSearchLimited([])).toBe(false);
  });
});
