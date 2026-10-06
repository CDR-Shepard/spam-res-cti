/**
 * The Booking section of the agent's instructions (plan 1D): the appointment
 * times outreach-api found free on the specialist's calendar, said in the
 * seller's time zone.
 *
 * Safe to render: every line is built from validated, structured data, never
 * plan text. Slot ids are `[pw][1-9]`; the day, date and time words come from
 * `Intl` formatting ISO instants; the specialist's first name is flattened
 * like any record value (prompt-context.ts). So nothing here passes through
 * `agentPlanTextIssues`, and the section sits after the plan fence.
 */
import type { AppointmentSlot } from '@cti/contracts';
import { propertyPhrase, type Ctx } from './prompt-context.js';

const KIND_WORDS: Readonly<Record<AppointmentSlot['kind'], string>> = { phone: 'phone call', walkthrough: 'walkthrough' };

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
 * The slot in the seller's time: "Wednesday, October 7 at 11 AM". When the
 * specialist's clock reads differently, their time follows for reference:
 * "Wednesday, October 7 at 2 PM their time, 11 AM Pacific".
 */
export function slotWords(slot: AppointmentSlot, sellerTz: string): string {
  const at = new Date(slot.start);
  const theirs = clock(at, sellerTz);
  const ours = clock(at, slot.timeZone);
  const base = `${day(at, sellerTz)} at ${theirs}`;
  return theirs === ours ? base : `${base} their time, ${ours} ${zoneWord(at, slot.timeZone)}`;
}

const PHONE_WORDS = 'a quick phone call (about fifteen minutes)';
const WALK_WORDS = 'an in-person walkthrough of the house (about an hour)';

/** What can be booked: both kinds (ask which), or only the one on offer (Fix 1, M-1: never mention a kind with no times). */
function offerLines(c: Ctx, who: string): string {
  const phone = c.slots.some((s) => s.kind === 'phone');
  const walk = c.slots.some((s) => s.kind === 'walkthrough');
  const choose = 'offer TWO times from the list below, in their time, and let them choose. If neither works, offer the next two.';
  if (phone && walk) {
    return `- You can book a time with ${who}. Two kinds:
  - ${PHONE_WORDS}, or
  - ${WALK_WORDS}.
- Ask which they'd prefer. Then offer TWO times of that kind from the list below, in their time, and let them choose. If neither works, offer the next two.`;
  }
  return `- You can book ${phone ? PHONE_WORDS : WALK_WORDS} with ${who}.
- ${choose.charAt(0).toUpperCase()}${choose.slice(1)}`;
}

/** The walkthrough's address check, only when a walkthrough is on offer. */
function walkthroughLine(c: Ctx): string {
  if (!c.slots.some((s) => s.kind === 'walkthrough')) return '';
  const otherwise = c.slots.some((s) => s.kind === 'phone')
    ? "don't book a walkthrough; offer the phone call instead."
    : "don't book it; offer to have the specialist call them back instead (schedule_callback).";
  return `- Before booking a walkthrough, confirm the property: "That's ${propertyPhrase(c, 'the')}, right?" Only book it once they say yes (address_confirmed true). If it's a different property, ${otherwise}\n`;
}

/** The Booking section, or null when there is nothing to offer. */
export function bookingSection(c: Ctx): string | null {
  if (c.slots.length === 0) return null;
  const first = c.slots.find((s) => s.specialistFirstName)?.specialistFirstName;
  const times = c.slots.map((s) => `- ${s.id}: ${KIND_WORDS[s.kind]}, ${slotWords(s, c.sellerTz)}`);
  return `# Booking an appointment
${offerLines(c, first ? `${first}, one of our specialists` : 'one of our specialists')}
- Say a time the way people do — "Thursday at two in the afternoon", "Wednesday the seventh, eleven in the morning". Never read out digits or a date as numbers, and only mention another time zone if they ask.
${walkthroughLine(c)}- Book only a time from this list, by its id. Never make up a time, and never promise a time you haven't booked.
- Call book_appointment silently. Then confirm the day and time in ONE line with your goodbye, then end_call with outcome "appointment_set".
- If book_appointment says that time was just taken, apologise briefly and offer another time from the list.
- If no time works: schedule_callback instead.
Times you can offer (their local time):
${times.join('\n')}`;
}
