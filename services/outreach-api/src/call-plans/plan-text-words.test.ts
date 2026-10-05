import { describe, expect, it } from 'vitest';
import { validPlan } from '../test/call-plan-fixtures.js';
import { describePlanTextIssues, planTextWarningWords } from './plan-text-words.js';

const { doNotContact: _omit, ...plan } = validPlan;

describe('describePlanTextIssues', () => {
  it('names each field by what the person sees, and each problem in plain words', () => {
    const words = describePlanTextIssues(plan, [
      { path: 'opener', issue: 'offer' },
      { path: 'goals.3.approach', issue: 'money' },
      { path: 'questions.0', issue: 'url' },
      { path: 'avoid.1', issue: 'human_claim' },
      { path: 'talkingPoints.2', issue: 'disclosure_skip' },
      { path: 'sellingSignals.0.signal', issue: 'control_char' },
    ]);
    expect(words).toEqual([
      'the opener: offer wording',
      'Their price in mind, how to ask: a price or an amount',
      'question 1: a web address',
      'avoid line 2: a claim to be human',
      'talking point 3: skipping the AI disclosure',
      'selling signal 1: a hidden or control character',
    ]);
  });

  it('groups the problems of one field and says so for the whole text', () => {
    expect(describePlanTextIssues(plan, [{ path: 'opener', issue: 'money' }, { path: 'opener', issue: 'offer' }])).toEqual(['the opener: a price or an amount, offer wording']);
    expect(describePlanTextIssues(plan, [{ path: '(rendered)', issue: 'url' }])).toEqual(['the whole plan: a web address']);
  });

  it('writes the warning and the 400 message', () => {
    expect(planTextWarningWords(['the opener: offer wording'])).toBe(
      "Can't approve: the voice agent can't be given this text. Edit it first. the opener: offer wording.",
    );
  });
});
