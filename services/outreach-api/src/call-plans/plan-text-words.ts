/**
 * The CF-9 plan-text check (the same one the voice agent's rendering runs) in the words a person reads on the board
 * and in the editor: which field, and what is wrong with it.
 */
import type { AgentPlanIssue, EditableCallPlan } from '@cti/contracts';
import { GOAL_LABELS, planTextIssues, type PlanTextIssue } from '../ai-calls/plan-text.js';

const ISSUE_WORDS: Readonly<Record<AgentPlanIssue, string>> = {
  money: 'a price or an amount',
  offer: 'offer wording',
  human_claim: 'a claim to be human',
  disclosure_skip: 'skipping the AI disclosure',
  url: 'a web address',
  angle_bracket: 'a < or > sign',
  control_char: 'a hidden or control character',
  disallowed_char: 'a character the voice agent cannot be given (an emoji, a symbol, a look-alike letter)',
  line_break: 'a line break',
};

/** `goals.3.approach` -> "Their price in mind, how to ask"; the paths are the plan's, the labels what the card shows. */
function fieldWords(plan: EditableCallPlan, path: string): string {
  const [head, index, tail] = path.split('.');
  const n = Number(index) + 1;
  switch (head) {
    case 'opener':
      return 'the opener';
    case 'goals': {
      const goal = plan.goals[Number(index)];
      return `${goal ? GOAL_LABELS[goal.goal] : `goal ${n}`}, ${tail === 'known' ? 'what we know' : 'how to ask'}`;
    }
    case 'questions':
      return `question ${n}`;
    case 'talkingPoints':
      return `talking point ${n}`;
    case 'avoid':
      return `avoid line ${n}`;
    case 'sellingSignals':
      return `selling signal ${n}`;
    default:
      return 'the whole plan';
  }
}

/** One phrase per field, fields in the order they were found, each field's problems joined. */
export function describePlanTextIssues(plan: EditableCallPlan, issues: readonly PlanTextIssue[]): string[] {
  const byField = new Map<string, string[]>();
  for (const { path, issue } of issues) {
    const field = fieldWords(plan, path);
    byField.set(field, [...(byField.get(field) ?? []), ISSUE_WORDS[issue]]);
  }
  return [...byField].map(([field, problems]) => `${field}: ${problems.join(', ')}`);
}

/** The plan's text problems as phrases, or `[]` when the voice agent can be given the plan. */
export function planTextProblems(plan: EditableCallPlan): string[] {
  return describePlanTextIssues(plan, planTextIssues(plan));
}

export const planTextWarningWords = (problems: readonly string[]): string =>
  `Can't approve: the voice agent can't be given this text. Edit it first. ${problems.join('; ')}.`;

export const planTextSaveWords = (problems: readonly string[]): string => `Can't save: the voice agent can't be given this text. ${problems.join('; ')}.`;
