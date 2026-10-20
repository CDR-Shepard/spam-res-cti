/**
 * The values a prompt template can use (its Mustache view), computed from one call's PromptInput with the
 * same helpers the prompt has always used (prompt-context.ts): record values flattened and stripped of
 * markup, the CRM notes fence-safe and capped, the plan checked again (CF-9) and fence-neutralised, slots
 * validated, and appointment times said in the seller's zone. Routing step 1 adds the seller's earlier and
 * booked consultations and the high-priority offer (dropped without a street, as the call's tools drop it).
 *
 * Every value is a string, a boolean or a list of string records, never a function, so a template can't
 * run a Mustache lambda. Every object is frozen and has no prototype, so a name such as `constructor`
 * finds nothing. Mustache inserts these values literally: a `{{` inside the notes is never re-parsed.
 */
import type { ConsultationFact, Consultations, PriorityOffer } from '@cti/contracts';
import { KIND_WORDS, bookedConsultationWords, consultationDay, priorityDefaultWords, slotWords } from './prompt-booking.js';
import { context, oneLine, phoneForms, promptPriority, propertyPhrase, type Ctx } from './prompt-context.js';
import type { PromptInput } from './prompt.js';

export type PromptViewValue = string | boolean | ReadonlyArray<Record<string, string>>;

const OWNER_NAME_MAX = 80;
/** Said for the high-priority specialist when the offer has no first name: "a visit from our specialist". */
const PRIORITY_SPECIALIST_FALLBACK = 'our specialist';
/** specialist_name when the offered times are with more than one rep: a saved template never names one rep for all of them. */
const SEVERAL_SPECIALISTS = 'one of our specialists';

/** A frozen copy with no prototype: only its own keys can be looked up. */
function bare<T extends Record<string, unknown>>(values: T): T {
  return Object.freeze(Object.assign(Object.create(null) as T, values));
}

/** A consultation Sam can talk about: null when there is none or its start is not a time, so no section is ever empty. */
function sayable(fact: ConsultationFact | null | undefined): ConsultationFact | null {
  return fact && Number.isFinite(Date.parse(fact.start)) ? fact : null;
}

/** "Blake" from "Blake Kossuth", flattened like any record value; '' when unknown. */
function firstWord(name: string | null): string {
  return oneLine(name, OWNER_NAME_MAX)?.split(' ')[0] ?? '';
}

/**
 * specialist_name, kept for saved custom templates (the default names each time's rep with time_with): the first named rep
 * when every time is with one rep, else SEVERAL_SPECIALISTS (final review I2).
 */
function specialistName(slots: Ctx['slots']): string {
  if (new Set(slots.map((s) => s.specialistSfUserId)).size > 1) return SEVERAL_SPECIALISTS;
  return slots.find((s) => s.specialistFirstName)?.specialistFirstName ?? '';
}

/** The seller's earlier consultation (`last`) and the one already booked (`next`), in their zone. */
function consultationValues(consultations: Consultations | undefined, c: Ctx) {
  const last = sayable(consultations?.last);
  const next = sayable(consultations?.next);
  return {
    had_consultation: last !== null,
    last_consultation_when: last ? consultationDay(last, c.sellerTz, c.localTime) : '',
    last_consultation_with: last ? firstWord(last.ownerName) : '',
    last_consultation_in_person: last?.kind === 'in_person',
    has_booked_consultation: next !== null,
    booked_consultation_text: next ? bookedConsultationWords(next, c.sellerTz, firstWord(next.ownerName)) : '',
  };
}

/** The high-priority offer as the call uses it (promptPriority): empty values without one. */
function priorityValues(priority: PriorityOffer | null, sellerTz: string) {
  return {
    can_book_priority: priority !== null,
    priority_specialist_name: priority ? (priority.specialistFirstName ?? PRIORITY_SPECIALIST_FALLBACK) : '',
    priority_default_text: priority ? priorityDefaultWords(priority, sellerTz) : '',
  };
}

export function promptView(input: PromptInput): Record<string, PromptViewValue> {
  const c = context(input);
  const priority = promptPriority(input.priority, input.address);
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
    can_book_any: c.slots.length > 0 || priority !== null,
    offers_phone_call: c.slots.some((s) => s.kind === 'phone'),
    offers_walkthrough: c.slots.some((s) => s.kind === 'walkthrough'),
    specialist_name: specialistName(c.slots),
    appointment_times: Object.freeze(
      c.slots.map((s) =>
        bare({ time_id: s.id, time_kind: KIND_WORDS[s.kind], time_with: s.specialistFirstName ?? '', time_text: slotWords(s, c.sellerTz) }),
      ),
    ),
    ...priorityValues(priority, c.sellerTz),
    ...consultationValues(input.consultations, c),
  });
}
