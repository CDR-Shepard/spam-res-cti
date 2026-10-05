/**
 * The approved plan as plain text for the voice agent (cti-api fences it as data and puts
 * its non-overridable rules after the fence).
 *
 * CF-9:
 *  - Only what helps the conversation is sent: the opener, the four goals, the questions,
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
import { PLAN_TEXT_MAX, agentPlanTextIssues, type AgentPlanIssue, type CallGoalKey, type EditableCallPlan } from '@cti/contracts';

export interface PlanTextIssue {
  /** The plan field, as a zod-style path (`goals.3.known`), or `(rendered)` for the whole text. */
  path: string;
  issue: AgentPlanIssue;
}

export type RenderedPlan = { ok: true; text: string } | { ok: false; issues: PlanTextIssue[] };

const GOAL_LABELS: Readonly<Record<CallGoalKey, string>> = {
  still_selling: 'Still selling?',
  timeline: 'Timeline',
  condition: 'Condition',
  price_expectations: 'Their price in mind',
};

const bullets = (items: readonly string[]): string => items.map((i) => `- ${i}`).join('\n');

/** Every plan field the agent may receive, with its path. */
function sentFields(plan: EditableCallPlan): Array<[string, string]> {
  return [
    ['opener', plan.opener],
    ...plan.goals.flatMap((g, i): Array<[string, string]> => [
      ...(g.known ? [[`goals.${i}.known`, g.known] as [string, string]] : []),
      [`goals.${i}.approach`, g.approach],
    ]),
    ...plan.questions.map((q, i): [string, string] => [`questions.${i}`, q]),
    ...plan.sellingSignals.map((s, i): [string, string] => [`sellingSignals.${i}.signal`, s.signal]),
    ...plan.talkingPoints.map((t, i): [string, string] => [`talkingPoints.${i}`, t]),
    ...plan.avoid.map((a, i): [string, string] => [`avoid.${i}`, a]),
  ];
}

/** CF-9 check of every field that would be sent; `[]` = the plan may go to the agent. */
export function planTextIssues(plan: EditableCallPlan): PlanTextIssue[] {
  return sentFields(plan).flatMap(([path, text]) => agentPlanTextIssues(text, { singleLine: true }).map((issue) => ({ path, issue })));
}

function required(plan: EditableCallPlan, questions: number): string[] {
  const goal = (g: EditableCallPlan['goals'][number]) => `- ${GOAL_LABELS[g.goal]} (${g.known ? `known: ${g.known}` : 'unknown'}) — ${g.approach}`;
  return [`Opener: ${plan.opener}`, `Goals:\n${plan.goals.map(goal).join('\n')}`, `Questions:\n${bullets(plan.questions.slice(0, questions))}`];
}

function optional(plan: EditableCallPlan): string[] {
  return [
    plan.sellingSignals.length ? `Selling signals:\n${bullets(plan.sellingSignals.map((s) => s.signal))}` : null,
    plan.talkingPoints.length ? `Talking points:\n${bullets(plan.talkingPoints)}` : null,
    plan.avoid.length ? `Avoid:\n${bullets(plan.avoid)}` : null,
  ].filter((s): s is string => s !== null);
}

/** The longest deterministic rendering within PLAN_TEXT_MAX. */
function fitted(plan: EditableCallPlan): string {
  const extra = optional(plan);
  for (let keep = extra.length; keep >= 0; keep -= 1) {
    const text = [...required(plan, plan.questions.length), ...extra.slice(0, keep)].join('\n\n');
    if (text.length <= PLAN_TEXT_MAX) return text;
  }
  for (let n = plan.questions.length - 1; n >= 1; n -= 1) {
    const text = required(plan, n).join('\n\n');
    if (text.length <= PLAN_TEXT_MAX) return text;
  }
  // Beyond the contract's field caps only: keep whole lines (a too-long first line is cut at a space).
  const lines = required(plan, 1).join('\n\n').split('\n');
  let out = '';
  for (const line of lines) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length > PLAN_TEXT_MAX) break;
    out = next;
  }
  return out || cutLine(lines[0] ?? '');
}

/** At most PLAN_TEXT_MAX characters, ending at a space when there is one, never half a surrogate pair. */
function cutLine(line: string): string {
  const head = line.slice(0, PLAN_TEXT_MAX);
  const space = head.lastIndexOf(' ');
  const cut = space > 0 ? head.slice(0, space) : head;
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export function renderPlanForAgent(plan: EditableCallPlan): RenderedPlan {
  const issues = planTextIssues(plan);
  if (issues.length > 0) return { ok: false, issues };
  const text = fitted(plan);
  // The labels and layout are ours, but the whole text is checked again exactly as cti-api will.
  const whole = agentPlanTextIssues(text, { singleLine: false });
  return whole.length > 0 ? { ok: false, issues: whole.map((issue) => ({ path: '(rendered)', issue })) } : { ok: true, text };
}
