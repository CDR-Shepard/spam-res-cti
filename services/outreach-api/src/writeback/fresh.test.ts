/** Fix 1, I-3: the pure part of the re-read before the PATCH. */
import { describe, expect, it } from 'vitest';
import { keepUnedited, sameValue } from './fresh.js';
import type { Change } from './plan.js';

const change = (field: string, before: string | null, after: string, why: Change['why']): Change => ({ field, label: field, before, after, why });

describe('sameValue', () => {
  it.each([
    [null, null, true],
    [null, 'x', false],
    ['Hot', 'hot', true],
    ['2026-10-06T22:20:00.000+0000', '2026-10-06T22:20:00.000Z', true],
    ['2026-10-06T22:20:00.000+0000', '2026-10-06T22:21:00.000Z', false],
    ['250000', '250000.0', true],
    ['Hot', 'Warm', false],
    // sweep D-25 N2: Salesforce keeps whole seconds; our own write had milliseconds.
    ['2026-10-06T22:20:05.000+0000', '2026-10-06T22:20:05.734Z', true],
    ['2026-10-06T22:20:06.000+0000', '2026-10-06T22:20:05.734Z', false],
  ])('%s vs %s → %s', (a, b, out) => {
    expect(sameValue(a, b)).toBe(out);
  });
});

describe('keepUnedited', () => {
  it('no status move in the patch: the plan-time status is the guard; a rep\'s stage holds Rating, a fill-blank still goes', () => {
    const out = keepUnedited({
      patch: { Rating__c: 'Cold', Timeline__c: '90 Days' },
      changes: [change('Rating__c', null, 'Cold', 'status'), change('Timeline__c', null, '90 Days', 'filled')],
      fresh: { StageName: 'Offer Made', Rating__c: null, Timeline__c: null },
      statusField: 'StageName',
      statusLabel: 'Stage',
      planStatus: 'Followup',
    });
    expect(out.patch).toEqual({ Timeline__c: '90 Days' });
    expect(out.notChanged).toEqual([{ field: 'Rating__c', label: 'Rating__c', now: null, held: 'Stage' }]);
  });

  it('a row planned before the status was recorded skips the guard; per-field checks still apply', () => {
    const out = keepUnedited({
      patch: { Rating__c: 'Cold' },
      changes: [change('Rating__c', null, 'Cold', 'status')],
      fresh: { StageName: 'Offer Made', Rating__c: null },
      statusField: 'StageName',
      planStatus: undefined,
    });
    expect(out.patch).toEqual({ Rating__c: 'Cold' });
  });

  it('do-not-call flags always go; a filled Removal Status a rep changed is kept (fill-blank rule)', () => {
    const out = keepUnedited({
      patch: { DoNotCall: true, Removal_Status__c: 'Remove me', Status: 'Unqualified' },
      changes: [change('DoNotCall', 'false', 'true', 'dnc'), change('Removal_Status__c', null, 'Remove me', 'dnc'), change('Status', 'Working', 'Unqualified', 'status')],
      fresh: { DoNotCall: true, Removal_Status__c: 'Spam', Status: 'Nurture' },
      statusField: 'Status',
      statusLabel: 'Status',
      planStatus: 'Working',
    });
    expect(out.patch).toEqual({ DoNotCall: true });
    expect(out.notChanged.map((n) => n.field)).toEqual(['Removal_Status__c', 'Status']);
    expect(out.notChanged.every((n) => n.held === undefined)).toBe(true);
  });
});
