/**
 * The function tools the AI phone agent may call, as Realtime `session.tools`
 * entries. Every schema is closed (`additionalProperties: false`); the call
 * service (Task 7) performs the side effects.
 *
 * Plan 1D: `book_appointment` (and the `appointment_set` end_call outcome) are
 * offered only on a call that carries appointment times (`toolsFor`).
 *
 * Inbound agent testing (plan 2026-10-16): an inbound call (a test phone called
 * the AI) is offered `INBOUND_TOOLS` only — `save_caller_details` and `end_call`;
 * an outbound call never gets `save_caller_details` (service-tools.ts refuses
 * any tool a call's direction was not offered).
 */
import { INBOUND_DETAIL_FIELDS, INBOUND_STATUSES, type AppointmentSlot, type InboundDetailField } from '@cti/contracts';

/** A Realtime API function tool (`session.update` → `session.tools[]`). */
export interface RealtimeFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** The call-service tools an outbound call may be offered (book_appointment only with slots). */
export const OUTBOUND_TOOL_NAMES = [
  'transfer_to_rep',
  'end_call',
  'mark_do_not_call',
  'save_qualification',
  'schedule_callback',
  'book_appointment',
] as const;

/** Every tool the call service runs: the outbound ones, then the inbound agent's details save. */
export const TOOL_NAMES = [...OUTBOUND_TOOL_NAMES, 'save_caller_details'] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const TRANSFER_REASONS = ['interested', 'wants_offer', 'wants_human', 'legal_or_complex', 'question'] as const;
/** The end_call outcomes on every call. */
const BASE_END_CALL_OUTCOMES = ['not_interested', 'do_not_call', 'wrong_number', 'qualified_callback', 'hung_up', 'other'] as const;
/** Every outcome end_call accepts; `appointment_set` is offered to the model only with slots. */
export const END_CALL_OUTCOMES = [...BASE_END_CALL_OUTCOMES, 'appointment_set'] as const;
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

function endCallTool(outcomes: readonly string[]): RealtimeFunctionTool {
  return {
    type: 'function',
    name: 'end_call',
    description: 'Hang up. Say your goodbye first, then call this; say nothing after it.',
    parameters: objectSchema(
      {
        outcome: {
          type: 'string',
          enum: [...outcomes],
          description: `qualified_callback = a callback was scheduled; hung_up = they left or the line went dead.${
            outcomes.includes('appointment_set') ? ' appointment_set = book_appointment booked a time.' : ''
          }`,
        },
        summary: str('One or two sentences on how the call went.'),
      },
      ['outcome', 'summary'],
    ),
  };
}

/** Answered by the bridge itself (no side effect): stay quiet and keep listening. Spec 2026-10-09 §4.2. */
export const WAIT_FOR_USER = 'wait_for_user';

export const WAIT_FOR_USER_TOOL: RealtimeFunctionTool = {
  type: 'function',
  name: WAIT_FOR_USER,
  description:
    "Say nothing and keep listening: what you heard wasn't meant for you (a TV, someone else in the room, noise), or they asked you to hold on.",
  parameters: { type: 'object', properties: {}, additionalProperties: false },
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
  endCallTool(BASE_END_CALL_OUTCOMES),
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
  WAIT_FOR_USER_TOOL,
];

/** Book one of the offered appointment times (plan 1D); `slotIds` are this call's slot ids. */
export function bookAppointmentTool(slotIds: readonly string[]): RealtimeFunctionTool {
  return {
    type: 'function',
    name: 'book_appointment',
    description:
      'Book one of the offered appointment times, once they have picked it. Call silently; then confirm the day and time in one line with your goodbye and end_call with outcome appointment_set. If it says the time was just taken, offer another time from the list.',
    parameters: objectSchema(
      {
        slot_id: { type: 'string', enum: [...slotIds], description: 'The id of the time they chose, from the list in your instructions.' },
        address_confirmed: { type: 'boolean', description: 'True only once they confirmed the property address (required for a walkthrough).' },
        note: str('Anything the specialist should know for the appointment (may be empty).'),
      },
      ['slot_id', 'address_confirmed', 'note'],
    ),
  };
}

/** The tools for a call: AI_CALL_TOOLS alone without slots; with slots, end_call also allows appointment_set and book_appointment is added. */
export function toolsFor(slots: readonly AppointmentSlot[]): RealtimeFunctionTool[] {
  if (slots.length === 0) return AI_CALL_TOOLS;
  return [
    ...AI_CALL_TOOLS.map((tool) => (tool.name === 'end_call' ? endCallTool(END_CALL_OUTCOMES) : tool)),
    bookAppointmentTool(slots.map((s) => s.id)),
  ];
}

const CALLER_DETAIL_HINTS: Record<InboundDetailField, string> = {
  location: 'Where the property is: the city or area, or the address if they gave it.',
  timeline: 'How soon they want to sell.',
  price_expectation: 'The price they hope to get, as they said it.',
  condition: 'The condition of the house and any repairs it needs.',
  decision_maker: 'Who decides on the sale: them, a spouse, other owners.',
  urgency: 'How urgent selling is for them, and why.',
  best_callback_time: 'When our team should call them back.',
  notes: 'Anything else the team should know: their reasons, their situation, other details about the property.',
};

/** The inbound agent's silent save: the caller's details and, before goodbye, how the call ended (`status`). */
export const SAVE_CALLER_DETAILS_TOOL: RealtimeFunctionTool = {
  type: 'function',
  name: 'save_caller_details',
  description: 'Save what the caller told you — only the fields you learned; call again as you learn more. Silent: never announce it.',
  parameters: objectSchema(
    {
      status: {
        type: 'string',
        enum: [...INBOUND_STATUSES],
        description: 'How the call ended: qualified, callback (they want a call back), disqualified, or incomplete.',
      },
      ...Object.fromEntries(INBOUND_DETAIL_FIELDS.map((f) => [f, str(CALLER_DETAIL_HINTS[f])])),
    },
    [],
  ),
};

/** The inbound agent's tools (a test phone called one of the AI's numbers): save the details, hang up. */
export const INBOUND_TOOLS: RealtimeFunctionTool[] = [
  SAVE_CALLER_DETAILS_TOOL,
  AI_CALL_TOOLS.find((tool) => tool.name === 'end_call') ?? endCallTool(BASE_END_CALL_OUTCOMES),
];
