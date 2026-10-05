/**
 * The function tools the AI phone agent may call, as Realtime `session.tools`
 * entries. Every schema is closed (`additionalProperties: false`); the call
 * service (Task 7) performs the side effects.
 */

/** A Realtime API function tool (`session.update` → `session.tools[]`). */
export interface RealtimeFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const TOOL_NAMES = [
  'transfer_to_rep',
  'end_call',
  'mark_do_not_call',
  'save_qualification',
  'schedule_callback',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const TRANSFER_REASONS = ['interested', 'wants_offer', 'wants_human', 'legal_or_complex', 'question'] as const;
export const END_CALL_OUTCOMES = [
  'not_interested',
  'do_not_call',
  'wrong_number',
  'qualified_callback',
  'hung_up',
  'other',
] as const;
export const QUALIFICATION_FIELDS = [
  'motivation',
  'timeline',
  'condition',
  'occupancy',
  'price_expectation',
  'decision_makers',
  'mortgage',
  'other',
] as const;

const str = (description: string) => ({ type: 'string', description });

function objectSchema(properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> {
  return { type: 'object', properties, required: [...required], additionalProperties: false };
}

const QUALIFICATION_HINTS: Record<(typeof QUALIFICATION_FIELDS)[number], string> = {
  motivation: 'Why they might sell, in their words.',
  timeline: 'How soon they would want to sell or move.',
  condition: 'Condition of the house and any repairs it needs.',
  occupancy: 'Who lives there now: owner, family, tenants, or vacant.',
  price_expectation: 'The price they said they would be happy with, as they said it.',
  decision_makers: 'Anyone else on the title or involved in the decision.',
  mortgage: 'Mortgage, liens, or back taxes they mentioned.',
  other: 'Anything else useful for the rep (e.g. language preference, best time to reach them).',
};

export const AI_CALL_TOOLS: RealtimeFunctionTool[] = [
  {
    type: 'function',
    name: 'transfer_to_rep',
    description:
      'Hand the caller live to a human specialist. Say one short line first ("let me grab one of our specialists"), then call this and stop talking.',
    parameters: objectSchema(
      {
        reason: { type: 'string', enum: [...TRANSFER_REASONS], description: 'Why you are handing off.' },
        summary: str('One or two sentences for the rep: who they are, what they want, key facts.'),
      },
      ['reason', 'summary'],
    ),
  },
  {
    type: 'function',
    name: 'end_call',
    description: 'Hang up. Say your goodbye first, then call this; say nothing after it.',
    parameters: objectSchema(
      {
        outcome: {
          type: 'string',
          enum: [...END_CALL_OUTCOMES],
          description: 'qualified_callback = a callback was scheduled; hung_up = they left or the line went dead.',
        },
        summary: str('One or two sentences on how the call went.'),
      },
      ['outcome', 'summary'],
    ),
  },
  {
    type: 'function',
    name: 'mark_do_not_call',
    description:
      'Record that this number must never be called again. Call it the moment they ask not to be called (then a short goodbye and end_call with outcome do_not_call), or on a wrong number with note "wrong number" (then end_call with outcome wrong_number).',
    parameters: objectSchema({ note: str('Their request in a few words, or "wrong number".') }, ['note']),
  },
  {
    type: 'function',
    name: 'save_qualification',
    description:
      "Save what you have learned about the seller. Call silently at a natural pause, batching what you've learned — not after every sentence; fill only the fields you learned, briefly, in their words.",
    parameters: objectSchema(
      Object.fromEntries(QUALIFICATION_FIELDS.map((f) => [f, str(QUALIFICATION_HINTS[f])])),
      [],
    ),
  },
  {
    type: 'function',
    name: 'schedule_callback',
    description: 'Ask the team to call this person back at the time they asked for.',
    parameters: objectSchema(
      {
        when: str(
          'When to call back: an ISO 8601 time if exact, else their words relative to their local time (e.g. "Thursday after 5 PM").',
        ),
        note: str('Anything the rep should know for the callback.'),
      },
      ['when', 'note'],
    ),
  },
];
