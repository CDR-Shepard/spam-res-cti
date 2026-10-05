import { describe, expect, it } from 'vitest';
import { CallPlan, EditableCallPlan, ResearchSourceSummary } from './call-plans.js';

export const validPlan = {
  situationSummary: 'Inherited the house in 2024; told a rep in May the roof leaks and the siblings disagree about selling.',
  sellingSignals: [{ signal: 'Wanted a quick sale before winter', evidence: '"we need this done before the cold"', source: 'task', strength: 'strong' }],
  opener: 'Ask whether the family has decided what to do with the house on Oak Street.',
  goals: [
    { goal: 'still_selling', known: 'Open to selling in May', approach: 'Ask if that is still the plan' },
    { goal: 'timeline', known: null, approach: 'Ask when they would want to be done' },
    { goal: 'condition', known: 'Roof leaks', approach: 'Ask if the roof was fixed' },
    { goal: 'price_expectations', known: null, approach: 'Ask if they have a number in mind; never give one' },
  ],
  talkingPoints: ['We buy as-is, so the roof does not need fixing first'],
  questions: ['Is everyone on the title on board with selling?'],
  avoid: ['Do not mention the probate attorney by name'],
  bestTimeToCall: { window: 'evening', reason: 'Works days; picked up at 6pm last time' },
  doNotContact: null,
};

describe('CallPlan', () => {
  it('accepts a complete plan', () => {
    expect(CallPlan.parse(validPlan)).toEqual(validPlan);
  });
  it('needs each of the four goals exactly once', () => {
    const twice = { ...validPlan, goals: [...validPlan.goals.slice(0, 3), validPlan.goals[0]] };
    expect(CallPlan.safeParse(twice).success).toBe(false);
  });
  it('needs at least one question and caps lists', () => {
    expect(CallPlan.safeParse({ ...validPlan, questions: [] }).success).toBe(false);
    expect(CallPlan.safeParse({ ...validPlan, talkingPoints: Array.from({ length: 9 }, () => 'x') }).success).toBe(false);
  });
  it('takes a do-not-contact flag with a category and a quote', () => {
    const flagged = { ...validPlan, doNotContact: { category: 'sold', quote: 'closed with another buyer in June' } };
    expect(CallPlan.parse(flagged).doNotContact?.category).toBe('sold');
  });
  it('an edit cannot carry a do-not-contact flag', () => {
    expect(Object.keys(EditableCallPlan.shape)).not.toContain('doNotContact');
  });
});

describe('ResearchSourceSummary', () => {
  it('records a degraded source', () => {
    expect(ResearchSourceSummary.parse({ source: 'chatter', status: 'missing', count: 0, truncated: false, note: 'INVALID_TYPE' }).status).toBe('missing');
  });
});
