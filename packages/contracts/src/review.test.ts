import { describe, expect, it } from 'vitest';
import { DoNotContactCategory, NeedsReviewResponse, ReviewDecision, TRIAGE_TAGS, TriageResult } from './index.js';

const valid = {
  summary: 'Inherited a vacant house and wants it gone before winter. Prefers texts during work hours.',
  channels: [
    { channel: 'sms', reason: '"text me, I can\'t talk at work"' },
    { channel: 'call', reason: '"call after 5pm"' },
  ],
  timing: 'after 5pm',
  tags: ['inherited', 'vacant', 'prefers_text'],
  doNotContact: null,
};

describe('review contracts', () => {
  it('the triage tag vocabulary is fixed at 20 tags', () => {
    expect(TRIAGE_TAGS).toHaveLength(20);
    expect(new Set(TRIAGE_TAGS).size).toBe(20);
    expect(DoNotContactCategory.options).toEqual(['sold', 'attorney', 'deceased', 'asked_no_contact', 'listed_with_agent', 'hostile', 'other']);
  });

  it('TriageResult parses a full result, an empty preference, and a do-not-contact flag', () => {
    expect(TriageResult.parse(valid)).toEqual(valid);
    expect(TriageResult.parse({ ...valid, channels: [], timing: null, tags: [] }).channels).toEqual([]);
    const flagged = { ...valid, doNotContact: { category: 'attorney', quote: '"talk to my lawyer"' } };
    expect(TriageResult.parse(flagged).doNotContact).toEqual({ category: 'attorney', quote: '"talk to my lawyer"' });
  });

  it.each([
    ['an unknown tag', { ...valid, tags: ['rich'] }],
    ['9 tags', { ...valid, tags: TRIAGE_TAGS.slice(0, 9) }],
    ['an empty summary', { ...valid, summary: '' }],
    ['a 601-char summary', { ...valid, summary: 'x'.repeat(601) }],
    ['a 301-char channel reason', { ...valid, channels: [{ channel: 'sms', reason: 'r'.repeat(301) }] }],
    ['an empty channel reason', { ...valid, channels: [{ channel: 'sms', reason: '' }] }],
    ['an unknown channel', { ...valid, channels: [{ channel: 'fax', reason: 'r' }] }],
    ['4 channels', { ...valid, channels: [1, 2, 3, 4].map(() => ({ channel: 'sms', reason: 'r' })) }],
    ['a 201-char timing', { ...valid, timing: 't'.repeat(201) }],
    ['a missing timing (must be null, not absent)', (({ timing: _drop, ...rest }) => rest)(valid)],
    ['an unknown do-not-contact category', { ...valid, doNotContact: { category: 'rude', quote: 'q' } }],
    ['a 301-char do-not-contact quote', { ...valid, doNotContact: { category: 'other', quote: 'q'.repeat(301) } }],
    ['an empty do-not-contact quote', { ...valid, doNotContact: { category: 'other', quote: '' } }],
  ])('TriageResult rejects %s', (_label, input) => {
    expect(TriageResult.safeParse(input).success).toBe(false);
  });

  it('NeedsReviewResponse parses a flagged enrollment', () => {
    const item = {
      enrollmentId: '11111111-1111-4111-8111-111111111111',
      campaignId: '22222222-2222-4222-8222-222222222222',
      campaignName: 'Probate leads',
      sfObject: 'Lead',
      sfRecordId: '00Q5f000001AbCdEAF',
      name: 'Pat Doe',
      ownerName: 'Rep One',
      category: 'sold',
      quote: '"we already sold it"',
      flaggedAt: '2026-10-04T12:00:00.000Z',
    };
    expect(NeedsReviewResponse.parse({ items: [item] })).toEqual({ items: [item] });
    expect(NeedsReviewResponse.safeParse({ items: [{ ...item, enrollmentId: 'not-a-uuid' }] }).success).toBe(false);
  });

  it('ReviewDecision is dismiss or confirm, nothing else', () => {
    expect(ReviewDecision.parse({ decision: 'dismiss' })).toEqual({ decision: 'dismiss' });
    expect(ReviewDecision.parse({ decision: 'confirm' })).toEqual({ decision: 'confirm' });
    for (const bad of [{ decision: 'snooze' }, {}, { decision: 'CONFIRM' }]) {
      expect(ReviewDecision.safeParse(bad).success).toBe(false);
    }
  });
});
