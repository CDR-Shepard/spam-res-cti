/**
 * The values a prompt template can use (its Mustache view), computed from one call's PromptInput with the
 * same helpers the prompt has always used (prompt-context.ts): record values flattened and stripped of
 * markup, the CRM notes fence-safe and capped, the plan checked again (CF-9) and fence-neutralised, slots
 * validated, and appointment times said in the seller's zone.
 *
 * Every value is a string, a boolean or a list of string records, never a function, so a template can't
 * run a Mustache lambda. Every object is frozen and has no prototype, so a name such as `constructor`
 * finds nothing. Mustache inserts these values literally: a `{{` inside the notes is never re-parsed.
 */
import { KIND_WORDS, slotWords } from './prompt-booking.js';
import { context, phoneForms, propertyPhrase } from './prompt-context.js';
import type { PromptInput } from './prompt.js';

export type PromptViewValue = string | boolean | ReadonlyArray<Record<string, string>>;

/** A frozen copy with no prototype: only its own keys can be looked up. */
function bare<T extends Record<string, unknown>>(values: T): T {
  return Object.freeze(Object.assign(Object.create(null) as T, values));
}

export function promptView(input: PromptInput): Record<string, PromptViewValue> {
  const c = context(input);
  const specialist = c.slots.find((s) => s.specialistFirstName)?.specialistFirstName ?? '';
  return bare({
    agent_name: c.agent,
    company_name: c.company,
    first_name: c.first ?? '',
    address: c.address ?? '',
    street: c.street ?? '',
    spoken_address: c.street ?? c.city ?? '',
    the_property: propertyPhrase(c, 'the'),
    their_property: propertyPhrase(c, 'their'),
    your_property: propertyPhrase(c, 'your'),
    local_time: c.localTime,
    crm_notes: c.notes,
    callback_number: c.phone?.written ?? '',
    callback_number_spoken: c.phone?.spoken ?? '',
    caller_number: phoneForms(input.callerNumber ?? null)?.written ?? '',
    call_plan: c.plan ?? '',
    is_test: c.isTest,
    returning: c.returning,
    can_book: c.slots.length > 0,
    offers_phone_call: c.slots.some((s) => s.kind === 'phone'),
    offers_walkthrough: c.slots.some((s) => s.kind === 'walkthrough'),
    specialist_name: specialist,
    appointment_times: Object.freeze(
      c.slots.map((s) => bare({ time_id: s.id, time_kind: KIND_WORDS[s.kind], time_text: slotWords(s, c.sellerTz) })),
    ),
  });
}
