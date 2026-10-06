import { describe, expect, it } from 'vitest';
import { agentPlanTextIssues, ResearchSource } from '@cti/contracts';
import type { ResearchSnapshot } from './snapshot.js';
import { contactWords, lastRealContact } from './last-contact.js';

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
    const s = snap([task('2026-09-30T17:00:00.000Z', 'AI call: No answer', { kind: 'Call', disposition: 'No answer' }), task('2026-02-12T18:00:00.000Z', 'Call with Pat', { kind: 'Call', disposition: 'Connected' })]);
    expect(lastRealContact(s, NOW)).toEqual({ at: new Date('2026-02-12T18:00:00.000Z'), kind: 'call' });
  });

  it('skips a call that left a voicemail or never connected, by title or disposition', () => {
    const s = snap([
      task('2026-09-01T17:00:00.000Z', 'Left voicemail', { kind: 'Call', seconds: '95' }),
      task('2026-08-01T17:00:00.000Z', 'Call', { kind: 'Call', disposition: 'No Answer' }),
      task('2026-07-01T17:00:00.000Z', 'Call - wrong number', { kind: 'Call', seconds: '70' }),
      task('2026-06-01T17:00:00.000Z', 'Call', { kind: 'Call', disposition: 'Busy' }),
      task('2026-05-01T17:00:00.000Z', 'Spoke with seller', { kind: 'Call', disposition: 'Connected' }),
    ]);
    expect(lastRealContact(s, NOW)).toEqual({ at: new Date('2026-05-01T17:00:00.000Z'), kind: 'call' });
  });

  it('skips a task that is not a call', () => {
    expect(lastRealContact(snap([task('2026-09-01T17:00:00.000Z', 'Send comps', { kind: 'Task', disposition: 'Connected' }), task('2026-09-02T17:00:00.000Z', 'Email', {})]), NOW)).toBeNull();
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
    const s = snap([task('2026-02-12T18:00:00.000Z', 'Call', { kind: 'Call', disposition: 'Connected' }), event('2026-01-01T00:00:00.000Z', '2026-06-01T18:00:00.000Z', 'Appointment'), email('2026-04-20T17:00:00.000Z', 'inbound')]);
    expect(lastRealContact(s, NOW)).toEqual({ at: new Date('2026-06-01T18:00:00.000Z'), kind: 'meeting' });
  });

  it('an empty snapshot gives null', () => {
    expect(lastRealContact(snap([]), NOW)).toBeNull();
  });
});

/**
 * Fix 1 (I-1): the call Task shapes production holds (org _t2, last 30 days, TaskSubtype 'Call'). The CTI subjects are
 * cti-api's buildCallSubject outputs ("<Inbound|Outbound> Call | <disposition> | <phone> / <name>"; an inbound call with
 * no disposition has no middle part); the AI ones are cti-api ai-voice/sf-logging's ("AI call: <outcome words>", with
 * CallDisposition from ctiDisposition: Connected whenever a person was reached).
 */
describe('lastRealContact: a call counts only with evidence that a person was reached', () => {
  const AT = '2026-09-14T17:00:00.000Z';
  const call = (title: string, meta: Record<string, string> = {}) => task(AT, title, { kind: 'Call', ...meta });
  const found = (i: Item) => lastRealContact(snap([i]), NOW);
  const WHO = '(619) 555-0142 / Pat Seller';

  it.each<[string, Item]>([
    ['Outbound Call | Connected', call(`Outbound Call | Connected | ${WHO}`, { disposition: 'Connected', callType: 'Outbound' })],
    ['Outbound Call | Call back that lasted two minutes', call(`Outbound Call | Call back | ${WHO}`, { disposition: 'Call back', callType: 'Outbound', seconds: '120' })],
    ['Outbound Call | Do not call', call(`Outbound Call | Do not call | ${WHO}`, { disposition: 'Do not call', callType: 'Outbound' })],
    ['the subject\'s disposition when CallDisposition was not written (a degraded Task)', call(`Outbound Call | Connected | ${WHO}`)],
    ['CallDisposition in any case', call('Call', { disposition: 'CONNECTED' })],
    ['an inbound call the rep marked Connected', call(`Inbound Call | Connected | ${WHO}`, { callType: 'Inbound', disposition: 'Connected', seconds: '30' })],
    ['an outbound CallRail recording of three minutes', call('CallRail Recording', { callType: 'Outbound', seconds: '180' })],
    ['an "Outgoing" call of two minutes', call('Outgoing | Dana Rep', { seconds: '120' })],
    ['a call shape with no TaskSubtype, by its CallType', task(AT, `Outbound Call | Connected | ${WHO}`, { callType: 'Outbound', disposition: 'Connected' })],
    ['a call shape with no TaskSubtype and no CallType, by its subject', task(AT, `Outbound Call | Connected | ${WHO}`, {})],
  ])('counts: %s', (_label, item) => {
    expect(found(item)).toEqual({ at: new Date(AT), kind: 'call' });
  });

  it.each<[string, Item]>([
    ['Outbound Call | No answer', call(`Outbound Call | No answer | ${WHO}`, { disposition: 'No answer', callType: 'Outbound' })],
    // Final review (OUT minor 3): "Call back" is also picked when someone else answered; it needs a real conversation's length.
    ['Outbound Call | Call back with no talk time', call(`Outbound Call | Call back | ${WHO}`, { disposition: 'Call back', callType: 'Outbound' })],
    ['a "Call back" subject under a minute', call(`Outbound Call | Call back | ${WHO}`, { seconds: '40' })],
    // An inbound recording with no disposition is often the seller's own voicemail, however long.
    ['an inbound call with no disposition that lasted a minute', call('Inbound Call | (619) 555-0142', { callType: 'Inbound', seconds: '60' })],
    ['an inbound CallRail recording of three minutes', call('CallRail Recording', { callType: 'Inbound', seconds: '180' })],
    ['a CallRail recording of three minutes with no direction', call('CallRail Recording', { seconds: '180' })],
    ['CallRail Recording with no duration', call('CallRail Recording', { callType: 'Inbound' })],
    ['CallRail Recording under a minute', call('CallRail Recording', { callType: 'Inbound', seconds: '59' })],
    ['Inbound Call | <phone> with no duration', call('Inbound Call | (619) 555-0142', { callType: 'Inbound' })],
    ['Outbound Call | Left voicemail, however long', call(`Outbound Call | Left voicemail | ${WHO}`, { disposition: 'Left voicemail', seconds: '95' })],
    ['Inbound Call | Not dispositioned', call(`Inbound Call | Not dispositioned | ${WHO}`, { disposition: 'Not dispositioned', callType: 'Inbound', seconds: '240' })],
    ['Outbound Call | Not dispositioned', call(`Outbound Call | Not dispositioned | ${WHO}`, { disposition: 'Not dispositioned', seconds: '240' })],
    ['Outbound Call | Bad number', call(`Outbound Call | Bad number | ${WHO}`, { disposition: 'Bad number' })],
    ['Outbound Call | Busy', call(`Outbound Call | Busy | ${WHO}`, { disposition: 'Busy' })],
    ['Outbound Call | Wrong number', call(`Outbound Call | Wrong number | ${WHO}`, { disposition: 'Wrong number', seconds: '70' })],
    ['Failed', call(`Outbound Call | Failed | ${WHO}`, { disposition: 'Failed' })],
    ['Blocked', call(`Outbound Call | Blocked | ${WHO}`, { disposition: 'Blocked' })],
    ['Abandoned', call('Call', { disposition: 'Abandoned', seconds: '80' })],
    ['LVM', call('Call', { disposition: 'LVM', seconds: '80' })],
    ['VoiceMail Drop | <rep>', call('VoiceMail Drop | Dana Rep', { seconds: '45' })],
    ['Missed Call | <rep>', call('Missed Call | Dana Rep', { seconds: '75' })],
    ['Inbound Call | anonymous, however long', call('Inbound Call | anonymous', { callType: 'Inbound', seconds: '300' })],
    ['an "Outgoing" call with no duration', call('Outgoing | Dana Rep')],
    ['a call Task with no disposition and no duration (a hand-logged "Call")', call('Spoke with seller')],
    ['the disposition segment wins over a long duration', call(`Outbound Call | No answer | ${WHO}`, { seconds: '600' })],
  ])('never counts: %s', (_label, item) => {
    expect(found(item)).toBeNull();
  });

  it('a record name holding a no-contact word does not hide a connected call', () => {
    expect(found(call('Outbound Call | Connected | (619) 555-0142 / Missy Busby', { disposition: 'Connected' }))).toEqual({ at: new Date(AT), kind: 'call' });
  });

  it('a lead with only No answer and VoiceMail Drop Tasks has no contact', () => {
    const s = snap([
      ...Array.from({ length: 12 }, (_, i) => task(`2026-09-${String(10 + i).padStart(2, '0')}T17:00:00.000Z`, `Outbound Call | No answer | ${WHO}`, { kind: 'Call', disposition: 'No answer', seconds: '30' })),
      task('2026-09-25T17:00:00.000Z', 'VoiceMail Drop | Dana Rep', { kind: 'Call' }),
    ]);
    expect(lastRealContact(s, NOW)).toBeNull();
  });

  it('a Connected call three weeks ago behind thirty newer No-answer Tasks is found', () => {
    const noAnswers = Array.from({ length: 30 }, (_, i) => task(new Date(NOW.getTime() - (i + 1) * 12 * 3_600_000).toISOString(), `Outbound Call | No answer | ${WHO}`, { kind: 'Call', disposition: 'No answer' }));
    const connected = task('2026-09-14T17:00:00.000Z', `Outbound Call | Connected | ${WHO}`, { kind: 'Call', disposition: 'Connected', seconds: '410' });
    expect(lastRealContact(snap([...noAnswers, connected]), NOW)).toEqual({ at: new Date('2026-09-14T17:00:00.000Z'), kind: 'call' });
  });
});

describe('lastRealContact: AI call Tasks count only when the AI had a conversation (M-9)', () => {
  const AT = '2026-09-14T17:00:00.000Z';
  const ai = (outcome: string, disposition?: string, meta: Record<string, string> = {}) =>
    task(AT, `AI call: ${outcome}`, { kind: 'Call', callType: 'Outbound', ...(disposition ? { disposition } : {}), ...meta });

  it.each<[string, Item]>([
    ['Transferred to rep', ai('Transferred to rep', 'Connected')],
    ['Callback requested', ai('Callback requested', 'Connected')],
    ['Not interested', ai('Not interested', 'Connected')],
    ['Do not call', ai('Do not call', 'Do not call')],
    ['Transfer missed — callback promised', ai('Transfer missed — callback promised', 'Connected')],
    ['Appointment set', ai('Appointment set', 'Connected')],
  ])('counts: AI call: %s', (_label, item) => {
    expect(lastRealContact(snap([item]), NOW)).toEqual({ at: new Date(AT), kind: 'call' });
  });

  it.each<[string, Item]>([
    ['No answer', ai('No answer', 'No answer')],
    ['Left voicemail', ai('Left voicemail', 'Left voicemail')],
    ['Busy', ai('Busy', 'Busy')],
    ['Failed', ai('Failed', 'Failed')],
    ['Blocked', ai('Blocked', 'Blocked')],
    ['Wrong number', ai('Wrong number', 'Wrong number')],
    ['Hung up (seconds into the call)', ai('Hung up', 'Connected')],
    ['Other', ai('Other', 'Other')],
    ['the open callback to-do "AI call: callback requested" (no disposition)', ai('callback requested', undefined, { status: 'Open', due: '2026-09-16' })],
    ['the open callback to-do with a time', ai('callback Wed, Sep 16, 5:00 PM', undefined, { status: 'Open', due: '2026-09-16' })],
    ['an outcome word with no disposition at all', ai('Not interested')],
    ['an "ai call" title in any case without a conversation', task(AT, 'ai CALL: qualified callback', { kind: 'Call' })],
  ])('never counts: AI call: %s', (_label, item) => {
    expect(lastRealContact(snap([item]), NOW)).toBeNull();
  });
});

describe('lastRealContact: a Task is dated by its ActivityDate when it has one (M-8)', () => {
  const connected = (at: string, due?: string) => task(at, 'Outbound Call | Connected | (619) 555-0142', { kind: 'Call', disposition: 'Connected', ...(due ? { due } : {}) });

  it('a call logged on October 1st for September 14th is dated September 14th', () => {
    const c = lastRealContact(snap([connected('2026-10-01T17:00:00.000Z', '2026-09-14')]), NOW);
    expect(c?.kind).toBe('call');
    expect(contactWords(c!.at, NOW)).toBe('back in September');
    expect(contactWords(c!.at, NOW, 'Pacific/Honolulu')).toBe('back in September');
  });

  it('the ActivityDate is read as that calendar day in the org\'s zone', () => {
    const c = lastRealContact(snap([connected('2026-10-05T18:00:00.000Z', '2026-09-28')]), NOW);
    expect(contactWords(c!.at, NOW)).toBe('last week');
  });

  it('a due date after the Task was created is not when the call happened: CreatedDate is used', () => {
    expect(lastRealContact(snap([connected('2026-09-14T17:00:00.000Z', '2026-10-20')]), NOW)).toEqual({ at: new Date('2026-09-14T17:00:00.000Z'), kind: 'call' });
  });

  it('a Task dated in the future is never contact', () => {
    expect(lastRealContact(snap([connected('2026-10-09T17:00:00.000Z')]), NOW)).toBeNull();
  });

  it('a malformed ActivityDate falls back to CreatedDate', () => {
    expect(lastRealContact(snap([connected('2026-09-14T17:00:00.000Z', 'soon')]), NOW)).toEqual({ at: new Date('2026-09-14T17:00:00.000Z'), kind: 'call' });
  });

  it('an older ActivityDate can make an older-created Task the newest contact', () => {
    const s = snap([connected('2026-10-01T17:00:00.000Z', '2026-08-01'), connected('2026-09-20T17:00:00.000Z')]);
    expect(lastRealContact(s, NOW)?.at).toEqual(new Date('2026-09-20T17:00:00.000Z'));
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

describe('final review OUT I-1: the targeted contact read (snapshot contacts) is searched with the recent activity', () => {
  const WHO = '(619) 555-0142 / Pat Seller';
  const noAnswer = (i: number) => task(new Date(NOW.getTime() - (i + 1) * 6 * 3_600_000).toISOString(), `Outbound Call | No answer | ${WHO}`, { kind: 'Call', disposition: 'No answer', callType: 'Outbound' });

  it('forty unanswered dials after the last connect: the connect, found by the targeted read, is the last contact', () => {
    const connect = task('2026-07-14T17:00:00.000Z', `Outbound Call | Connected | ${WHO}`, { kind: 'Call', disposition: 'Connected', seconds: '300' });
    const s = { ...snap(Array.from({ length: 25 }, (_, i) => noAnswer(i))), contacts: [connect] };
    const c = lastRealContact(s, NOW);
    expect(c).toEqual({ at: new Date('2026-07-14T17:00:00.000Z'), kind: 'call' });
    expect(contactWords(c!.at, NOW)).toBe('back in July');
  });

  it('an archived connected call more than a year ago reads "about a year ago"', () => {
    const archived = task('2025-08-20T17:00:00.000Z', `Outbound Call | Connected | ${WHO}`, { kind: 'Call', disposition: 'Connected' });
    const c = lastRealContact({ ...snap([noAnswer(1)]), contacts: [archived] }, NOW);
    expect(contactWords(c!.at, NOW)).toBe('about a year ago');
  });

  it('the newest of the two reads wins, and targeted rows face the same evidence rules', () => {
    const recent = task('2026-09-20T17:00:00.000Z', `Outbound Call | Connected | ${WHO}`, { kind: 'Call', disposition: 'Connected' });
    const older = task('2026-03-01T17:00:00.000Z', `Outbound Call | Connected | ${WHO}`, { kind: 'Call', disposition: 'Connected' });
    expect(lastRealContact({ ...snap([recent]), contacts: [older] }, NOW)?.at).toEqual(new Date('2026-09-20T17:00:00.000Z'));
    const voicemail = task('2026-09-25T17:00:00.000Z', `Outbound Call | Left voicemail | ${WHO}`, { kind: 'Call', disposition: 'Left voicemail', seconds: '95' });
    expect(lastRealContact({ ...snap([]), contacts: [voicemail] }, NOW)).toBeNull();
  });
});
