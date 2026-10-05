import { describe, expect, it } from 'vitest';
import { validPlan } from '../test/call-plan-fixtures.js';
import { isPlainText, planTextIssues } from './plain-text.js';

describe('isPlainText', () => {
  it.each([
    ['ordinary text with newlines and tabs', 'Line one\n\tLine two', true],
    ['a carriage return', 'a\r\nb', true],
    ['an emoji pair', 'Great call 👍', true],
    ['numbers and null', { n: 1, x: null }, true],
    ['a NUL', 'bad\u0000text', false],
    ['an escape character', 'bad\u001b[31m', false],
    ['DEL', 'bad\u007ftext', false],
    ['a C1 control (NEL)', 'bad\u0085text', false],
    ['a C1 control (CSI)', 'bad\u009btext', false],
    ['a right-to-left override', 'abc\u202edef', false],
    ['a bidi isolate', 'abc\u2066def\u2069', false],
    ['a zero-width space', 'ab\u200bcd', false],
    ['a zero-width joiner', 'ab\u200dcd', false],
    ['a byte-order mark', '\ufeffabc', false],
    ['a soft hyphen', 'ab\u00adcd', false],
    ['a line separator', 'ab\u2028cd', false],
    ['a paragraph separator', 'ab\u2029cd', false],
    ['a lone high surrogate', 'cut\ud83d', false],
    ['a lone low surrogate', '\ude00cut', false],
    ['a bad string nested in an array of objects', { a: [{ b: 'x\u0007' }] }, false],
    ['a bad object key', { 'k\u0000': 'v' }, false],
  ])('%s', (_name, value, expected) => {
    expect(isPlainText(value)).toBe(expected);
  });
});

describe('planTextIssues (one field rule: single-line fields reject line breaks)', () => {
  const { doNotContact: _omit, ...plan } = validPlan;

  it('finds nothing in a valid plan, and lets the summary run over several lines', () => {
    expect(planTextIssues(plan)).toEqual([]);
    expect(planTextIssues({ ...plan, situationSummary: 'Line one\n\nLine two' })).toEqual([]);
  });

  it.each([
    ['opener', { opener: 'a\nb' }, ['opener']],
    ['a goal approach', { goals: plan.goals.map((g, i) => (i === 1 ? { ...g, approach: 'a\rb' } : g)) }, ['goals.1.approach']],
    ['a goal known', { goals: plan.goals.map((g, i) => (i === 0 ? { ...g, known: 'a\nb' } : g)) }, ['goals.0.known']],
    ['best time reason', { bestTimeToCall: { window: 'any' as const, reason: 'a\u2028b' } }, ['bestTimeToCall.reason']],
    ['a talking point', { talkingPoints: ['fine', 'a\nb'] }, ['talkingPoints.1']],
    ['a question', { questions: ['a\nb'] }, ['questions.0']],
    ['an avoid line', { avoid: ['a\nb'] }, ['avoid.0']],
  ])('rejects a line break in %s', (_name, over, paths) => {
    expect(planTextIssues({ ...plan, ...over })).toEqual(paths);
  });

  it('skips sellingSignals: evidence is verbatim record text, discarded and replaced server-side (I-1)', () => {
    const signals = [{ signal: 'Wants out\u200b', evidence: 'line one\nline two\ufeff\u202e', source: 'note' as const, strength: 'strong' as const }];
    expect(planTextIssues({ ...plan, sellingSignals: signals })).toEqual([]);
    // Everything else is still checked.
    expect(planTextIssues({ ...plan, sellingSignals: signals, opener: 'a\nb' })).toEqual(['opener']);
  });

  it('also reports control and format characters in any field, the summary included', () => {
    expect(planTextIssues({ ...plan, situationSummary: 'a\u202eb' })).toEqual(['situationSummary']);
    expect(planTextIssues({ ...plan, opener: 'a\u200bb', questions: ['x\u0000'] })).toEqual(['opener', 'questions.0']);
  });
});
