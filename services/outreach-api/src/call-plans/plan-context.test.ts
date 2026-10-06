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
const call = { source: 'task' as const, id: '00T000000000000001', at: '2026-02-12T18:00:00.000Z', title: 'Spoke with Pat', body: '', meta: { kind: 'Call' } };
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
    expect(planFacts(s, NOW)).toEqual({ lastContactWords: 'back in February', lastContactKind: 'call', missing: ['timeline', 'price'] });
  });

  it('with no contact and no self block, nothing was contact and every topic with a field is missing', () => {
    expect(planFacts(snap([]), NOW)).toEqual({ lastContactWords: null, lastContactKind: null, missing: QUALIFICATION_TOPICS.filter((t) => t !== 'decision_makers') });
  });
});

const facts = (over: Partial<PlanFacts> = {}): PlanFacts => ({ lastContactWords: 'back in February', lastContactKind: 'call', missing: ['timeline', 'price'], ...over });
const plan = (over: Partial<CallPlan> = {}): CallPlan => ({ ...validPlan, ...over });

describe('withPlanFacts', () => {
  it.each<[string, CallPlan, PlanFacts, CallPlan['reengagement'], QualificationTopic[]]>([
    ['keeps only the model topics that are missing', plan({ stillToLearn: ['price', 'condition'] }), facts(), { lastContact: 'back in February', lastTopic: null }, ['price']],
    ['falls back to every missing topic when the model named none', plan({ stillToLearn: [] }), facts(), { lastContact: 'back in February', lastTopic: null }, ['timeline', 'price']],
    ['falls back when none of the model topics is missing', plan({ stillToLearn: ['condition'] }), facts(), { lastContact: 'back in February', lastTopic: null }, ['timeline', 'price']],
    [
      'replaces the model words with the computed words, keeping its topic',
      plan({ reengagement: { lastContact: 'in 2024', lastTopic: 'the roof leak' } }),
      facts(),
      { lastContact: 'back in February', lastTopic: 'the roof leak' },
      ['timeline', 'price'],
    ],
    ['no contact: re-engagement is null even when the model wrote one', plan({ reengagement: { lastContact: 'last week', lastTopic: 'the roof' } }), facts({ lastContactWords: null, lastContactKind: null }), null, ['timeline', 'price']],
    ['nothing missing: nothing still to learn', plan({ stillToLearn: ['price'] }), facts({ missing: [] }), { lastContact: 'back in February', lastTopic: null }, []],
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
  const stored = { ...validPlan, reengagement: { lastContact: 'back in February', lastTopic: 'the roof leak' }, stillToLearn: ['timeline', 'price'] };
  it.each<[string, Partial<typeof editable>, unknown, CallPlan['reengagement'], QualificationTopic[]]>([
    ['an old body (defaults) keeps everything stored', { reengagement: null, stillToLearn: [] }, stored, { lastContact: 'back in February', lastTopic: 'the roof leak' }, ['timeline', 'price']],
    ['a tampered lastContact is replaced; the edited topic stays', { reengagement: { lastContact: 'last week', lastTopic: 'the move' } }, stored, { lastContact: 'back in February', lastTopic: 'the move' }, ['timeline', 'price']],
    ['clearing the topic is allowed', { reengagement: { lastContact: 'back in February', lastTopic: null } }, stored, { lastContact: 'back in February', lastTopic: null }, ['timeline', 'price']],
    ['the person\'s topics are kept', { stillToLearn: ['condition', 'condition'] }, stored, { lastContact: 'back in February', lastTopic: 'the roof leak' }, ['condition']],
    ['no stored contact: none can be added', { reengagement: { lastContact: 'back in May', lastTopic: 'x' } }, validPlan, null, []],
    ['an unreadable stored plan reads as no contact and no topics', {}, { opener: 1 }, null, []],
  ])('%s', (_label, over, storedPlan, reengagement, stillToLearn) => {
    const out = withStoredFacts({ ...editable, ...over }, storedPlan);
    expect(out.reengagement).toEqual(reengagement);
    expect(out.stillToLearn).toEqual(stillToLearn);
  });
});
