import { describe, expect, it } from 'vitest';
import { AiConsentStatus, CallPlan, CallPlanVersion, EditableCallPlan, GateWarning, QUALIFICATION_TOPICS, QualificationTopic, Reengagement, ResearchSourceSummary } from './call-plans.js';

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
    expect(CallPlan.parse(validPlan)).toEqual({ ...validPlan, reengagement: null, stillToLearn: [] });
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

describe('AiConsentStatus', () => {
  it('has an explicit unknown, so a consent value that could not be read is never shown as no', () => {
    expect(AiConsentStatus.options).toEqual(['yes', 'no', 'field_missing', 'unknown']);
    expect(AiConsentStatus.safeParse('unknown').success).toBe(true);
  });
});

describe('GateWarning', () => {
  it('names an unreadable consent and the two do-not-contact holds', () => {
    for (const code of ['consent_unknown', 'dnc_pending', 'dnc_not_dismissed']) {
      expect(GateWarning.safeParse({ code, severity: 'block', words: 'x' }).success).toBe(true);
    }
  });
});

describe('CallPlanVersion', () => {
  const base = { version: 2, status: 'proposed', source: 'model', plan: EditableCallPlan.parse(validPlan), createdAt: '2026-10-05T10:00:00.000Z', decidedAt: null, dncFlagDismissed: true };

  it('carries who dismissed a do-not-contact flag and when, or null when it was not recorded', () => {
    expect(CallPlanVersion.parse({ ...base, dncFlagDismissedBy: 'Rita Rep', dncFlagDismissedAt: '2026-10-05T11:00:00.000Z' }).dncFlagDismissedBy).toBe('Rita Rep');
    expect(CallPlanVersion.parse({ ...base, dncFlagDismissedBy: null, dncFlagDismissedAt: null }).dncFlagDismissedAt).toBeNull();
    expect(CallPlanVersion.safeParse(base).success).toBe(false);
  });
});

describe('plan 1D re-engagement fields', () => {
  it('an old stored plan with no reengagement or stillToLearn parses to null and []', () => {
    const parsed = EditableCallPlan.parse(validPlan);
    expect(parsed.reengagement).toBeNull();
    expect(parsed.stillToLearn).toEqual([]);
    expect(CallPlan.parse(validPlan).reengagement).toBeNull();
  });

  it('a plan with both parses and keeps them', () => {
    const plan = {
      ...validPlan,
      reengagement: { lastContact: 'back in February', lastTopic: 'They wanted to wait until the tenants moved out' },
      stillToLearn: ['timeline', 'mortgage'],
    };
    expect(CallPlan.parse(plan)).toEqual(plan);
  });

  it('an unknown topic is rejected', () => {
    expect(CallPlan.safeParse({ ...validPlan, stillToLearn: ['zodiac_sign'] }).success).toBe(false);
  });

  it('caps stillToLearn at nine and the re-engagement words', () => {
    expect(CallPlan.safeParse({ ...validPlan, stillToLearn: [...QUALIFICATION_TOPICS, 'motivation'] }).success).toBe(false);
    expect(Reengagement.safeParse({ lastContact: 'x'.repeat(81), lastTopic: null }).success).toBe(false);
    expect(Reengagement.safeParse({ lastContact: null, lastTopic: 'x'.repeat(201) }).success).toBe(false);
  });

  it('EditableCallPlan keeps both new keys', () => {
    expect(Object.keys(EditableCallPlan.shape)).toEqual(expect.arrayContaining(['reengagement', 'stillToLearn']));
  });

  it('the nine qualification topics', () => {
    expect([...QualificationTopic.options]).toEqual([
      'motivation', 'timeline', 'condition', 'repairs', 'occupancy', 'price', 'competition', 'mortgage', 'decision_makers',
    ]);
    expect(QUALIFICATION_TOPICS).toBe(QualificationTopic.options);
  });
});
