import { describe, expect, it } from 'vitest';
import { QUALIFICATION_TOPICS, ResearchSource, type CallPlan, type QualificationTopic } from '@cti/contracts';
import type { ResearchSnapshot } from '../research/snapshot.js';
import { validPlan } from '../test/call-plan-fixtures.js';
import { planFacts, withPlanFacts, withStoredFacts, type PlanFacts } from './plan-context.js';

const NOW = new Date('2026-10-05T19:00:00.000Z');
type Block = ResearchSnapshot['records'][number];

function snap(records: Block[], activity: ResearchSnapshot['activity'] = []): ResearchSnapshot {
  return {
    version: 1,
    sfObject: 'Lead',
    sfRecordId: '00Q000000000000001',
    collectedAt: NOW.toISOString(),
    consent: 'yes',
    records,
    activity,
    sources: ResearchSource.options.map((source) => ({ source, status: 'ok' as const, count: 0, truncated: false, note: null })),
    truncated: false,
  };
}
const block = (relation: Block['relation'], fields: Array<[string, string]>): Block => ({
  relation,
  sfObject: relation === 'self' ? 'Lead' : 'Opportunity',
  id: relation === 'self' ? '00Q000000000000001' : '006000000000000001',
  role: null,
  fields: fields.map(([name, value]) => ({ name, label: name, value })),
});
const call = { source: 'task' as const, id: '00T000000000000001', at: '2026-02-12T18:00:00.000Z', title: 'Outbound Call | Connected | (619) 555-0142 / Pat Seller', body: '', meta: { kind: 'Call', disposition: 'Connected' } };
const answeredButTimelineAndPrice: Array<[string, string]> = [
  ['Motivation__c', 'Inherited'],
  ['Condition__c', 'Fair'],
  ['Major_Repairs_Needed__c', 'Roof'],
  ['Occupancy__c', 'Vacant'],
  ['Competition__c', 'None'],
  ['Amount_Owed__c', '12'],
];

describe('planFacts', () => {
  it('reads the last real contact in words and what the self block is missing', () => {
    const s = snap([block('self', answeredButTimelineAndPrice), block('converted_opportunity', [['Timeline__c', '30 Days']])], [call]);
    expect(planFacts(s, NOW)).toEqual({ lastContactWords: 'back in February', lastContactAt: new Date('2026-02-12T18:00:00.000Z'), lastContactKind: 'call', contactSearchLimited: false, missing: ['timeline', 'price'] });
  });

  it('Fix 1 (I-2): a qualification field research never read is not reported missing', () => {
    const self = { ...block('self', answeredButTimelineAndPrice), qualificationFieldsRead: ['Motivation__c', 'Condition__c', 'Major_Repairs_Needed__c', 'Occupancy__c', 'Competition__c', 'Amount_Owed__c', 'Seller_s_Asking_Price__c'] };
    expect(planFacts(snap([self], [call]), NOW).missing).toEqual(['price']);
  });

  it('with no contact and no self block, nothing was contact and every topic with a field is missing', () => {
    expect(planFacts(snap([]), NOW)).toEqual({ lastContactWords: null, lastContactAt: null, lastContactKind: null, contactSearchLimited: false, missing: QUALIFICATION_TOPICS.filter((t) => t !== 'decision_makers') });
  });

  it('Fix 1 (M-8): says the search was limited when research cut the tasks, events or emails short, or the snapshot', () => {
    const cut = (source: string): ResearchSnapshot => ({ ...snap([]), sources: snap([]).sources.map((x) => (x.source === source ? { ...x, truncated: true } : x)) });
    for (const source of ['tasks', 'events', 'emails']) expect(planFacts(cut(source), NOW).contactSearchLimited).toBe(true);
    expect(planFacts(cut('chatter'), NOW).contactSearchLimited).toBe(false);
    expect(planFacts({ ...snap([]), truncated: true }, NOW).contactSearchLimited).toBe(true);
  });
});

const FEB = '2026-02-12T18:00:00.000Z';
const facts = (over: Partial<PlanFacts> = {}): PlanFacts => ({ lastContactWords: 'back in February', lastContactAt: new Date(FEB), lastContactKind: 'call', contactSearchLimited: false, missing: ['timeline', 'price'], ...over });
/** Fix 1 (M-4): the stored re-engagement carries the contact's date and kind. */
const feb = (lastTopic: string | null) => ({ lastContact: 'back in February', lastContactAt: FEB, lastContactKind: 'call' as const, lastTopic });
const plan = (over: Partial<CallPlan> = {}): CallPlan => ({ ...validPlan, ...over });

describe('withPlanFacts', () => {
  it.each<[string, CallPlan, PlanFacts, CallPlan['reengagement'], QualificationTopic[]]>([
    ['keeps only the model topics that are missing', plan({ stillToLearn: ['price', 'condition'] }), facts(), feb(null), ['price']],
    ['falls back to every missing topic when the model named none', plan({ stillToLearn: [] }), facts(), feb(null), ['timeline', 'price']],
    ['falls back when none of the model topics is missing', plan({ stillToLearn: ['condition'] }), facts(), feb(null), ['timeline', 'price']],
    [
      'replaces the model words with the computed words, keeping its topic',
      plan({ reengagement: { lastContact: 'in 2024', lastTopic: 'the roof leak' } }),
      facts(),
      feb('the roof leak'),
      ['timeline', 'price'],
    ],
    [
      'an email contact is stored with its kind',
      plan({ reengagement: { lastContact: 'x', lastTopic: 'the move' } }),
      facts({ lastContactKind: 'email' }),
      { ...feb('the move'), lastContactKind: 'email' },
      ['timeline', 'price'],
    ],
    ['no contact: re-engagement is null even when the model wrote one', plan({ reengagement: { lastContact: 'last week', lastTopic: 'the roof' } }), facts({ lastContactWords: null, lastContactKind: null }), null, ['timeline', 'price']],
    ['nothing missing: nothing still to learn', plan({ stillToLearn: ['price'] }), facts({ missing: [] }), feb(null), []],
  ])('%s', (_label, input, f, reengagement, stillToLearn) => {
    const out = withPlanFacts(input, f);
    expect(out.reengagement).toEqual(reengagement);
    expect(out.stillToLearn).toEqual(stillToLearn);
    expect(out.opener).toBe(input.opener);
  });

  it('returns a new plan and leaves the input alone', () => {
    const input = plan({ stillToLearn: ['price', 'condition'], reengagement: { lastContact: 'x', lastTopic: 'y' } });
    const copy = structuredClone(input);
    const out = withPlanFacts(input, facts());
    expect(out).not.toBe(input);
    expect(input).toEqual(copy);
  });
});

describe('withStoredFacts (a person\'s edit)', () => {
  const { doNotContact: _d, ...editable } = validPlan;
  const stored = { ...validPlan, reengagement: feb('the roof leak'), stillToLearn: ['timeline', 'price'] };
  it.each<[string, Partial<typeof editable>, unknown, CallPlan['reengagement'], QualificationTopic[]]>([
    ['an old body (defaults) keeps everything stored', { reengagement: null, stillToLearn: [] }, stored, feb('the roof leak'), ['timeline', 'price']],
    ['a tampered lastContact is replaced; the edited topic stays', { reengagement: { lastContact: 'last week', lastTopic: 'the move' } }, stored, feb('the move'), ['timeline', 'price']],
    [
      'Fix 1 (M-4): a tampered date or kind is replaced by the stored ones',
      { reengagement: { lastContact: 'back in February', lastContactAt: '2026-10-04T18:00:00.000Z', lastContactKind: 'email', lastTopic: 'the move' } },
      stored,
      feb('the move'),
      ['timeline', 'price'],
    ],
    [
      'a plan stored before Fix 1 has no date or kind, and none is added',
      { reengagement: { lastContact: 'back in February', lastContactAt: '2026-10-04T18:00:00.000Z', lastTopic: 'x' } },
      { ...validPlan, reengagement: { lastContact: 'back in February', lastTopic: 'the roof' } },
      { lastContact: 'back in February', lastContactAt: null, lastContactKind: null, lastTopic: 'x' },
      [],
    ],
    ['clearing the topic is allowed', { reengagement: { lastContact: 'back in February', lastTopic: null } }, stored, feb(null), ['timeline', 'price']],
    ['the person\'s topics are kept', { stillToLearn: ['condition', 'condition'] }, stored, feb('the roof leak'), ['condition']],
    ['no stored contact: none can be added', { reengagement: { lastContact: 'back in May', lastTopic: 'x' } }, validPlan, null, []],
    ['an unreadable stored plan reads as no contact and no topics', {}, { opener: 1 }, null, []],
  ])('%s', (_label, over, storedPlan, reengagement, stillToLearn) => {
    const out = withStoredFacts({ ...editable, ...over }, storedPlan);
    expect(out.reengagement).toEqual(reengagement);
    expect(out.stillToLearn).toEqual(stillToLearn);
  });
});
