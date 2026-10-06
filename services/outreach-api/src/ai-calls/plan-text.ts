/**
 * The approved plan as plain text for the voice agent (cti-api fences it as data and puts
 * its non-overridable rules after the fence).
 *
 * CF-9:
 *  - Only what helps the conversation is sent: the opener (with, plan 1D, the last contact and the topics still to learn), the four goals, the questions,
 *    and (space allowing) the selling signals' names, talking points and things to avoid.
 *    NEVER the situation summary, a signal's evidence quote, the do-not-contact quote or
 *    the best time to call: those are record content the agent has no need to repeat.
 *  - Every field that is sent passes `agentPlanTextIssues` as a single line (no prices,
 *    offers, human claims, disclosure skips, URLs, angle brackets, control characters or
 *    line breaks). A failing plan is refused with the offending paths, so it goes back to
 *    the board and never to the agent.
 *  - The text is at most PLAN_TEXT_MAX characters. Whole sections are dropped from the end
 *    (avoid, then talking points, then selling signals), then whole questions (one always
 *    stays), so the cut is deterministic and never splits a character.
 */
import {
  PLAN_TEXT_MAX,
  agentPlanTextIssues,
  contactLabel,
  lastContactWordsAt,
  type AgentPlanIssue,
  type CallGoalKey,
  type EditableCallPlan,
  type QualificationTopic,
} from '@cti/contracts';

export interface PlanTextIssue {
  /** The plan field, as a zod-style path (`goals.3.known`), or `(rendered)` for the whole text. */
  path: string;
  issue: AgentPlanIssue;
}

export type RenderedPlan = { ok: true; text: string } | { ok: false; issues: PlanTextIssue[] };

export const GOAL_LABELS: Readonly<Record<CallGoalKey, string>> = {
  still_selling: 'Still selling?',
  timeline: 'Timeline',
  condition: 'Condition',
  price_expectations: 'Their price in mind',
};

/** Copied from outreach-web's TOPIC_WORDS (lib/call-words.ts): the server never imports web code. */
export const TOPIC_LABELS: Readonly<Record<QualificationTopic, string>> = {
  motivation: "why they'd sell",
  timeline: 'timeline',
  condition: 'condition',
  repairs: 'repairs',
  occupancy: 'who lives there',
  price: 'their price in mind',
  competition: 'other offers or agents',
  mortgage: 'what they owe',
  decision_makers: 'who decides',
};

const bullets = (items: readonly string[]): string => items.map((i) => `- ${i}`).join('\n');

/**
 * S-1: what the records say about THEIR price is never sent, only whether the plan knows it. The agent is told never to
 * name a price, and a number in its instructions is a number it can say. Every other goal sends its `known` text.
 */
const knownText = (g: EditableCallPlan['goals'][number]): string | null => (g.goal === 'price_expectations' ? null : g.known);

/**
 * Fix 1 (M-4): the last contact in words as of `now` (the moment the plan is rendered for a call or checked), worked
 * out from its stored date; a plan stored before Fix 1 keeps its stored words.
 */
const contactAt = (plan: EditableCallPlan, now: Date): string | null => lastContactWordsAt(plan.reengagement, now);

/** Every plan field the agent may receive, with its path. */
function sentFields(plan: EditableCallPlan, now: Date): Array<[string, string]> {
  const r = plan.reengagement;
  const words = contactAt(plan, now);
  return [
    ['opener', plan.opener],
    ...(words ? [['reengagement.lastContact', words] as [string, string]] : []),
    ...(r?.lastTopic ? [['reengagement.lastTopic', r.lastTopic] as [string, string]] : []),
    ...plan.goals.flatMap((g, i): Array<[string, string]> => {
      const known = knownText(g);
      return [...(known ? [[`goals.${i}.known`, known] as [string, string]] : []), [`goals.${i}.approach`, g.approach]];
    }),
    ...plan.questions.map((q, i): [string, string] => [`questions.${i}`, q]),
    ...plan.sellingSignals.map((s, i): [string, string] => [`sellingSignals.${i}.signal`, s.signal]),
    ...plan.talkingPoints.map((t, i): [string, string] => [`talkingPoints.${i}`, t]),
    ...plan.avoid.map((a, i): [string, string] => [`avoid.${i}`, a]),
  ];
}

/** CF-9 check of every field that would be sent; `[]` = the plan may go to the agent. */
export function planTextIssues(plan: EditableCallPlan, now: Date = new Date()): PlanTextIssue[] {
  return sentFields(plan, now).flatMap(([path, text]) => agentPlanTextIssues(text, { singleLine: true }).map((issue) => ({ path, issue })));
}

/**
 * Plan 1D: right after the opener, and part of what is required, so the cut never drops them. A plan stored before 1D
 * (no re-engagement, nothing still to learn) renders exactly as it did. Fix 1 (M-5): the label follows the kind of
 * contact ("Last email from them" for an email).
 */
function returningLines(plan: EditableCallPlan, now: Date): string[] {
  const r = plan.reengagement;
  const words = contactAt(plan, now);
  return [
    ...(words ? [`${contactLabel(r?.lastContactKind)}: ${words}${r?.lastTopic ? ` — ${r.lastTopic}` : ''}`] : []),
    ...(plan.stillToLearn.length ? [`Still to learn: ${plan.stillToLearn.map((t) => TOPIC_LABELS[t]).join(', ')}`] : []),
  ];
}

function required(plan: EditableCallPlan, questions: number, now: Date): string[] {
  const state = (g: EditableCallPlan['goals'][number]): string => {
    if (!g.known) return 'unknown';
    return g.goal === 'price_expectations' ? 'known' : `known: ${g.known}`;
  };
  const goal = (g: EditableCallPlan['goals'][number]) => `- ${GOAL_LABELS[g.goal]} (${state(g)}) — ${g.approach}`;
  return [[`Opener: ${plan.opener}`, ...returningLines(plan, now)].join('\n'), `Goals:\n${plan.goals.map(goal).join('\n')}`, `Questions:\n${bullets(plan.questions.slice(0, questions))}`];
}

function optional(plan: EditableCallPlan): string[] {
  return [
    plan.sellingSignals.length ? `Selling signals:\n${bullets(plan.sellingSignals.map((s) => s.signal))}` : null,
    plan.talkingPoints.length ? `Talking points:\n${bullets(plan.talkingPoints)}` : null,
    plan.avoid.length ? `Avoid:\n${bullets(plan.avoid)}` : null,
  ].filter((s): s is string => s !== null);
}

/** The longest deterministic rendering within PLAN_TEXT_MAX. */
function fitted(plan: EditableCallPlan, now: Date): string {
  const extra = optional(plan);
  for (let keep = extra.length; keep >= 0; keep -= 1) {
    const text = [...required(plan, plan.questions.length, now), ...extra.slice(0, keep)].join('\n\n');
    if (text.length <= PLAN_TEXT_MAX) return text;
  }
  for (let n = plan.questions.length - 1; n >= 1; n -= 1) {
    const text = required(plan, n, now).join('\n\n');
    if (text.length <= PLAN_TEXT_MAX) return text;
  }
  // Beyond the contract's field caps only: keep whole lines (a too-long first line is cut at a space).
  const lines = required(plan, 1, now).join('\n\n').split('\n');
  let out = '';
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length > PLAN_TEXT_MAX) break;
    out = next;
  }
  return out || cutLine(lines[0] ?? '');
}

/** At most PLAN_TEXT_MAX characters, ending at a space when there is one. */
function cutLine(line: string): string {
  const head = line.slice(0, PLAN_TEXT_MAX);
  const space = head.lastIndexOf(' ');
  return space > 0 ? head.slice(0, space) : head;
}

/** `now`: when the call is triggered; the last contact's words are said as of then (Fix 1, M-4). */
export function renderPlanForAgent(plan: EditableCallPlan, now: Date = new Date()): RenderedPlan {
  const issues = planTextIssues(plan, now);
  if (issues.length > 0) return { ok: false, issues };
  const text = fitted(plan, now);
  // The labels and layout are ours, but the whole text is checked again exactly as cti-api will.
  const whole = agentPlanTextIssues(text, { singleLine: false });
  return whole.length > 0 ? { ok: false, issues: whole.map((issue) => ({ path: '(rendered)', issue })) } : { ok: true, text };
}
