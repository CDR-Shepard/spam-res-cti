import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '@cti/contracts';
import { historyDigest, type HistoryItem } from './digest.js';

type Call = Extract<TimelineItem, { type: 'call' }>;
type Email = Extract<TimelineItem, { type: 'email' }>;
type Note = Extract<TimelineItem, { type: 'note' }>;

let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const call = (at: string, over: Partial<Call> = {}): Call => ({
  type: 'call',
  id: id(),
  at,
  outcome: 'voicemail',
  summary: 'Left a message about the house.',
  durationSeconds: 42,
  transcriptAvailable: true,
  ...over,
});

const email = (at: string, over: Partial<Email> = {}): Email => ({
  type: 'email',
  id: id(),
  at,
  direction: 'out',
  actor: 'sam',
  subject: 'Your house',
  body: 'Hello there.',
  status: 'sent',
  autoReply: false,
  notSentReason: null,
  ...over,
});

const note = (at: string, over: Partial<Note> = {}): Note => ({ type: 'note', id: id(), at, kind: 'status', detail: 'booked', byName: null, ...over });

describe('historyDigest', () => {
  it('writes one line per item, in the order given (oldest first)', () => {
    const digest = historyDigest(
      [
        call('2026-10-01T15:00:00.000Z'),
        email('2026-10-02T16:00:00.000Z', { subject: 'Following up', body: 'Are you still selling?' }),
        email('2026-10-03T17:30:00.000Z', { direction: 'in', actor: 'seller', subject: 'Re: Following up', body: 'Yes, call me.' }),
      ],
      1000,
    );
    expect(digest.split('\n')).toEqual([
      '2026-10-01 Call — Voicemail. Left a message about the house.',
      '2026-10-02 Email from Sam — "Following up": Are you still selling?',
      '2026-10-03 Email from the seller — "Re: Following up": Yes, call me.',
    ]);
  });

  it('keeps the newest whole lines under the cap and drops the oldest', () => {
    const items = Array.from({ length: 6 }, (_, i) =>
      email(`2026-10-0${i + 1}T12:00:00.000Z`, { subject: `Mail ${i + 1}`, body: `${'x'.repeat(250)} ${i + 1}` }),
    );
    const digest = historyDigest(items, 1000);
    expect(digest.length).toBeLessThanOrEqual(1000);
    const lines = digest.split('\n');
    // Whole lines only, and a run ending at the newest item.
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(6);
    expect(lines.at(-1)).toMatch(/^2026-10-06 Email from Sam — "Mail 6": x+ 6$/);
    for (const line of lines) expect(line).toMatch(/^2026-10-0\d Email from Sam — "Mail \d": x{250} \d$/);
    expect(digest).not.toContain('"Mail 1"');
  });

  it('counts the newlines between lines against the cap', () => {
    const a = email('2026-10-01T12:00:00.000Z', { subject: 'A', body: 'aaaa' });
    const b = email('2026-10-02T12:00:00.000Z', { subject: 'B', body: 'bbbb' });
    const lineB = '2026-10-02 Email from Sam — "B": bbbb';
    const lineA = '2026-10-01 Email from Sam — "A": aaaa';
    expect(historyDigest([a, b], lineA.length + 1 + lineB.length)).toBe(`${lineA}\n${lineB}`);
    expect(historyDigest([a, b], lineA.length + lineB.length)).toBe(lineB);
  });

  it('is empty for no items, a zero cap, or a newest line that does not fit', () => {
    expect(historyDigest([], 1000)).toBe('');
    expect(historyDigest([call('2026-10-01T15:00:00.000Z')], 0)).toBe('');
    expect(historyDigest([call('2026-10-01T15:00:00.000Z')], 10)).toBe('');
  });

  it('skips an auto-reply and a canceled email', () => {
    const digest = historyDigest(
      [
        email('2026-10-01T12:00:00.000Z', { direction: 'in', actor: 'seller', subject: 'Out of office', body: 'Back Monday.', autoReply: true }),
        email('2026-10-02T12:00:00.000Z', { subject: 'Never sent', body: 'This did not go.', status: 'canceled', notSentReason: 'suppressed' }),
        email('2026-10-03T12:00:00.000Z', { subject: 'Real', body: 'Hi.' }),
      ],
      1000,
    );
    expect(digest).toBe('2026-10-03 Email from Sam — "Real": Hi.');
  });

  it('lists Sam\'s outbound email only once the seller got it: sent, delivered or complained (M3)', () => {
    const statuses = ['queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'canceled'] as const;
    const digest = historyDigest(
      statuses.map((status, i) => email(`2026-10-0${i + 1}T12:00:00.000Z`, { subject: status, body: `body ${status}`, status })),
      2000,
    );
    expect(digest.split('\n')).toEqual([
      '2026-10-03 Email from Sam — "sent": body sent',
      '2026-10-04 Email from Sam — "delivered": body delivered',
      '2026-10-06 Email from Sam — "complained": body complained',
    ]);
  });

  it('always lists the seller\'s own email (received), unless it is an auto-reply (M3)', () => {
    const digest = historyDigest([email('2026-10-01T12:00:00.000Z', { direction: 'in', actor: 'seller', subject: 'Re: Your house', body: 'Call me.', status: 'received' })], 1000);
    expect(digest).toBe('2026-10-01 Email from the seller — "Re: Your house": Call me.');
  });

  it('leaves out an email from an address other than the seller\'s (M8): it is not the seller speaking', () => {
    const items: HistoryItem[] = [
      { ...email('2026-10-01T12:00:00.000Z', { direction: 'in', actor: 'seller', subject: 'Re: Your house', body: 'I am the neighbour.', status: 'received' }), otherSender: true },
      email('2026-10-02T12:00:00.000Z', { direction: 'in', actor: 'seller', subject: 'Re: Your house', body: 'This is Pat.', status: 'received' }),
    ];
    expect(historyDigest(items, 1000)).toBe('2026-10-02 Email from the seller — "Re: Your house": This is Pat.');
  });

  it('flattens a body with newlines to one line', () => {
    const digest = historyDigest([email('2026-10-01T12:00:00.000Z', { body: 'Hi Pat,\r\n\r\nAre you\n  still selling?\n\nSam' })], 1000);
    expect(digest).toBe('2026-10-01 Email from Sam — "Your house": Hi Pat, Are you still selling? Sam');
    expect(digest).not.toMatch(/[\r\n]/);
  });

  it('keeps only the first 300 characters of a body and of a call summary', () => {
    const body = `${'b'.repeat(300)}TAIL`;
    const summary = `${'s'.repeat(300)}TAIL`;
    const lines = historyDigest([call('2026-10-01T12:00:00.000Z', { summary }), email('2026-10-02T12:00:00.000Z', { body })], 2000).split('\n');
    expect(lines[0]).toBe(`2026-10-01 Call — Voicemail. ${'s'.repeat(300)}`);
    expect(lines[1]).toBe(`2026-10-02 Email from Sam — "Your house": ${'b'.repeat(300)}`);
  });

  it('writes a call with no summary without a summary part, and one with no outcome as "call"', () => {
    const digest = historyDigest(
      [
        call('2026-10-01T12:00:00.000Z', { summary: null, outcome: 'appointment_set' }),
        call('2026-10-02T12:00:00.000Z', { summary: null, outcome: null }),
        call('2026-10-03T12:00:00.000Z', { summary: 'Wants a call back.', outcome: null }),
      ],
      1000,
    );
    expect(digest.split('\n')).toEqual([
      '2026-10-01 Call — Appointment set.',
      '2026-10-02 Call — call.',
      '2026-10-03 Call — call. Wants a call back.',
    ]);
  });

  it('writes a note with its detail', () => {
    expect(historyDigest([note('2026-10-04T09:00:00.000Z', { kind: 'handler', detail: 'taken_over', byName: 'Pat' })], 1000)).toBe('2026-10-04 Note — taken_over');
  });

  it('flattens a call summary, a subject and a note detail too (one line per item)', () => {
    const digest = historyDigest(
      [
        call('2026-10-01T12:00:00.000Z', { summary: 'Line one.\nLine two.' }),
        email('2026-10-02T12:00:00.000Z', { subject: 'Two\nlines', body: 'ok' }),
        note('2026-10-03T12:00:00.000Z', { detail: 'a\nb' }),
      ],
      1000,
    );
    expect(digest.split('\n')).toEqual([
      '2026-10-01 Call — Voicemail. Line one. Line two.',
      '2026-10-02 Email from Sam — "Two lines": ok',
      '2026-10-03 Note — a b',
    ]);
  });
});
