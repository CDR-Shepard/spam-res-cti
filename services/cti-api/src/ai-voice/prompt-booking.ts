/**
 * Appointment times (plan 1D) as the agent's instructions say them: the times outreach-api found free on
 * the specialist's calendar, in the seller's time zone. The Booking section itself is part of the
 * instructions template (prompt-default-instructions.ts); these words fill its list (prompt-view.ts).
 * Routing step 1 adds the words for the seller's earlier and booked consultations and the high-priority
 * default start, said the same way.
 *
 * Safe to render: every word is built from validated, structured data, never plan text. Slot ids are
 * `[pw][1-9]`; the day, date and time words come from `Intl` formatting ISO instants; the specialist's
 * first name is flattened like any record value (prompt-context.ts). So nothing here passes through
 * `agentPlanTextIssues`, and the section sits after the plan fence.
 */
import type { AppointmentSlot, ConsultationFact, PriorityOffer } from '@cti/contracts';

/** How each kind of appointment is named in the list of times. */
export const KIND_WORDS: Readonly<Record<AppointmentSlot['kind'], string>> = { phone: 'phone consultation', walkthrough: 'in-person consultation' };

/** Intl's parts by type for `at` in `timeZone`. */
function parts(at: Date, timeZone: string, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone, ...opts }).formatToParts(at)) out[p.type] = p.value;
  return out;
}

/** "11 AM" / "11:30 AM" (plain spaces only: ICU may put a narrow no-break space before AM/PM). */
function clock(at: Date, timeZone: string): string {
  const p = parts(at, timeZone, { hour: 'numeric', minute: '2-digit', hour12: true });
  const minutes = p.minute === '00' ? '' : `:${p.minute}`;
  return `${p.hour}${minutes} ${(p.dayPeriod ?? '').toUpperCase()}`.trim();
}

/** "Wednesday, October 7". */
function day(at: Date, timeZone: string): string {
  const p = parts(at, timeZone, { weekday: 'long', month: 'long', day: 'numeric' });
  return `${p.weekday}, ${p.month} ${p.day}`;
}

/** "Pacific" for America/Los_Angeles ("Pacific Time" without " Time"). */
function zoneWord(at: Date, timeZone: string): string {
  const name = parts(at, timeZone, { timeZoneName: 'longGeneric' }).timeZoneName ?? timeZone;
  return name.replace(/ Time$/, '');
}

/**
 * `at` in the seller's time: "Wednesday, October 7 at 11 AM". When the specialist's clock reads
 * differently, their time follows for reference: "Wednesday, October 7 at 2 PM their time, 11 AM Pacific".
 */
function whenWords(at: Date, sellerTz: string, specialistTz: string): string {
  const theirs = clock(at, sellerTz);
  const ours = clock(at, specialistTz);
  const base = `${day(at, sellerTz)} at ${theirs}`;
  return theirs === ours ? base : `${base} their time, ${ours} ${zoneWord(at, specialistTz)}`;
}

/** The slot in the seller's time (whenWords). */
export function slotWords(slot: AppointmentSlot, sellerTz: string): string {
  return whenWords(new Date(slot.start), sellerTz, slot.timeZone);
}

/**
 * The high-priority start offered when the seller names none, said like a slot: Pacific follows when the seller's clock
 * reads differently, because book_priority_appointment takes the time in Pacific.
 */
export function priorityDefaultWords(priority: PriorityOffer, sellerTz: string): string {
  return whenWords(new Date(priority.defaultStart), sellerTz, priority.timeZone);
}

/** The first 4-digit year `localTime` names ("Tuesday, October 6, 2026, 4:12 PM" → "2026"), or null. */
const yearOf = (localTime: string): string | null => /\b(\d{4})\b/.exec(localTime)?.[1] ?? null;

/**
 * The day of an earlier consultation in the seller's zone: "March 12", or "March 12, 2025" when that is not the year of
 * their local time. A local time that names no year gets the year every time: never a guessed year.
 */
export function consultationDay(fact: ConsultationFact, sellerTz: string, localTime: string): string {
  const p = parts(new Date(fact.start), sellerTz, { year: 'numeric', month: 'long', day: 'numeric' });
  const date = `${p.month} ${p.day}`;
  return p.year === yearOf(localTime) ? date : `${date}, ${p.year}`;
}

/**
 * A booked consultation in the seller's zone, with who and how: "Wednesday, October 21 at 11 AM with Seth, in person" or
 * "…, by phone"; " with Seth" only when `firstName` is known.
 */
export function bookedConsultationWords(fact: ConsultationFact, sellerTz: string, firstName: string): string {
  const at = new Date(fact.start);
  const who = firstName ? ` with ${firstName}` : '';
  return `${day(at, sellerTz)} at ${clock(at, sellerTz)}${who}, ${fact.kind === 'in_person' ? 'in person' : 'by phone'}`;
}
