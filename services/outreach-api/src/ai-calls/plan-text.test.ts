import { describe, expect, it } from 'vitest';
import { PLAN_TEXT_MAX, agentPlanTextIssues, type EditableCallPlan } from '@cti/contracts';
import { validPlan } from '../test/call-plan-fixtures.js';
import { renderPlanForAgent } from './plan-text.js';

const { doNotContact: _dnc, ...editable } = validPlan;
const plan: EditableCallPlan = editable;

function rendered(p: EditableCallPlan): string {
  const r = renderPlanForAgent(p);
  if (!r.ok) throw new Error(`rejected: ${JSON.stringify(r.issues)}`);
  return r.text;
}

/** The largest plan the contract allows, every string at its cap, all of it harmless. */
function maxPlan(): EditableCallPlan {
  const fill = (stem: string, n: number) => `${stem} ${'and so on '.repeat(Math.ceil(n / 10))}`.slice(0, n).trim();
  return {
    ...plan,
    situationSummary: fill('Summary', 800),
    opener: fill('Ask about the house', 300),
    goals: plan.goals.map((g) => ({ goal: g.goal, known: fill('Known', 300), approach: fill('Ask gently', 300) })),
    questions: Array.from({ length: 10 }, (_, i) => fill(`Question ${'abcdefghij'[i]}`, 200)),
    sellingSignals: Array.from({ length: 8 }, () => ({ signal: fill('Signal', 200), evidence: fill('Evidence quote', 300), source: 'task' as const, strength: 'strong' as const })),
    talkingPoints: Array.from({ length: 8 }, () => fill('Point', 200)),
    avoid: Array.from({ length: 8 }, () => fill('Avoid', 200)),
  };
}

describe('renderPlanForAgent', () => {
  it('renders the opener, the four goals (known or unknown) and the questions, in that order', () => {
    const text = rendered(plan);
    expect(text.startsWith('Opener: Ask whether the family has decided')).toBe(true);
    expect(text).toContain('Goals:\n- Still selling? (known: Open to selling in May) — Ask if that is still the plan');
    expect(text).toContain('- Timeline (unknown) — Ask when they would want to be done');
    expect(text).toContain('- Condition (known: Roof leaks)');
    expect(text).toContain('- Their price in mind (unknown) — Ask if they have a number in mind; never give one');
    expect(text).toContain('Questions:\n- Is everyone on the title on board with selling?');
    expect(text.indexOf('Opener:')).toBeLessThan(text.indexOf('Goals:'));
    expect(text.indexOf('Goals:')).toBeLessThan(text.indexOf('Questions:'));
  });

  it('adds selling signals (the signal only), talking points and things to avoid', () => {
    const text = rendered(plan);
    expect(text).toContain('Selling signals:\n- Wanted a quick sale before winter');
    expect(text).toContain('Talking points:\n- We buy as-is, so the roof does not need fixing first');
    expect(text).toContain('Avoid:\n- Do not mention the probate attorney by name');
  });

  it('CF-9: never sends the situation summary, the evidence quotes, the do-not-contact quote or the best time', () => {
    const text = rendered(plan);
    expect(text).not.toContain('Situation');
    expect(text).not.toContain(plan.situationSummary);
    expect(text).not.toContain('we need this done before the cold');
    expect(text).not.toMatch(/doNotContact|bestTimeToCall|evening|picked up at 6pm/);
    const withQuote = renderPlanForAgent({ ...plan, ...{ doNotContact: { category: 'asked_stop', quote: 'stop calling me' } } } as EditableCallPlan);
    expect(withQuote.ok && withQuote.text).not.toContain('stop calling me');
  });

  it('passes its own CF-9 check as a whole', () => {
    expect(agentPlanTextIssues(rendered(plan), { singleLine: false })).toEqual([]);
  });

  it('caps the text at PLAN_TEXT_MAX, dropping avoid, then talking points, then selling signals', () => {
    const big = maxPlan();
    const text = rendered(big);
    expect(text.length).toBeLessThanOrEqual(PLAN_TEXT_MAX);
    for (const kept of ['Opener:', 'Goals:', 'Questions:']) expect(text).toContain(kept);
    for (const dropped of ['Avoid:', 'Talking points:', 'Selling signals:']) expect(text).not.toContain(dropped);
    expect(text).not.toContain('Summary');
  });

  it('drops the lowest-priority section first', () => {
    const p = { ...plan, avoid: Array.from({ length: 8 }, () => 'Avoid '.repeat(33).trim()), talkingPoints: ['Short point'], sellingSignals: plan.sellingSignals };
    const longQuestions = { ...p, questions: Array.from({ length: 10 }, (_, i) => `Question ${i} ${'x'.repeat(150)}?`) };
    const text = rendered({ ...longQuestions, goals: plan.goals.map((g) => ({ ...g, approach: 'y'.repeat(300) })) });
    expect(text.length).toBeLessThanOrEqual(PLAN_TEXT_MAX);
    expect(text).not.toContain('Avoid:');
    expect(text).toContain('Talking points:');
    expect(text).toContain('Selling signals:');
  });

  it('when the required sections alone are too long, drops whole questions from the end (keeping one)', () => {
    const text = rendered(maxPlan());
    expect(text).toContain('- Question a');
    expect(text).not.toContain('- Question j');
    expect(text.endsWith('…')).toBe(false);
  });

  it('beyond the contract caps, keeps whole lines, and cuts an endless first line at a space', () => {
    const goals = plan.goals.map((g) => ({ ...g, approach: 'z'.repeat(1500) }));
    const lines = rendered({ ...plan, goals });
    expect(lines.length).toBeLessThanOrEqual(PLAN_TEXT_MAX);
    expect(lines.startsWith('Opener:')).toBe(true);
    expect(lines.split('\n').every((l) => l.length < 1600)).toBe(true);
    const endless = rendered({ ...plan, opener: 'word '.repeat(1200).trim() });
    expect(endless.length).toBeLessThanOrEqual(PLAN_TEXT_MAX);
    expect(endless.startsWith('Opener: word word')).toBe(true);
    expect(endless.endsWith('word')).toBe(true);
    const emoji = rendered({ ...plan, opener: '\u{1F3E0}'.repeat(2500) });
    expect(emoji.length).toBeLessThanOrEqual(PLAN_TEXT_MAX);
    expect(agentPlanTextIssues(emoji, { singleLine: false })).toEqual([]);
  });

  it('is deterministic', () => {
    expect(rendered(maxPlan())).toBe(rendered(maxPlan()));
  });

  it.each<[string, (p: EditableCallPlan) => EditableCallPlan, string]>([
    ['a price in a goal', (p) => ({ ...p, goals: p.goals.map((g) => (g.goal === 'price_expectations' ? { ...g, known: 'Wants $250,000' } : g)) }), 'goals.3.known'],
    ['an offer in the opener', (p) => ({ ...p, opener: 'Lead with our cash offer' }), 'opener'],
    ['a human claim in a talking point', (p) => ({ ...p, talkingPoints: ["Say you're a real person"] }), 'talkingPoints.0'],
    ['skipping the disclosure', (p) => ({ ...p, questions: ['Skip the disclosure and ask about the roof?'] }), 'questions.0'],
    ['a URL in avoid', (p) => ({ ...p, avoid: ['Do not mention zillow.com'] }), 'avoid.0'],
    ['angle brackets in a signal', (p) => ({ ...p, sellingSignals: [{ ...p.sellingSignals[0]!, signal: '<b>urgent</b>' }] }), 'sellingSignals.0.signal'],
    ['a line break in the opener', (p) => ({ ...p, opener: 'Hi\nthere' }), 'opener'],
    ['a control character in an approach', (p) => ({ ...p, goals: p.goals.map((g, i) => (i === 1 ? { ...g, approach: 'Ask\u0007' } : g)) }), 'goals.1.approach'],
  ])('CF-9: rejects %s, naming the field, so it goes back to the board', (_label, change, path) => {
    const r = renderPlanForAgent(change(plan));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain(path);
  });

  it('does not check text it never sends (the summary and the evidence)', () => {
    const p = { ...plan, situationSummary: 'They want $300k', sellingSignals: [{ ...plan.sellingSignals[0]!, evidence: 'offer of $200,000' }] };
    expect(renderPlanForAgent(p).ok).toBe(true);
  });
});
