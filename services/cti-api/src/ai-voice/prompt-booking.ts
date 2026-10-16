/**
 * Appointment times (plan 1D) as the agent's instructions say them: the times outreach-api found free on
 * the specialist's calendar, in the seller's time zone. The Booking section itself is part of the
 * instructions template (prompt-default-instructions.ts); these words fill its list (prompt-view.ts).
 *
 * Safe to render: every word is built from validated, structured data, never plan text. Slot ids are
 * `[pw][1-9]`; the day, date and time words come from `Intl` formatting ISO instants; the specialist's
 * first name is flattened like any record value (prompt-context.ts). So nothing here passes through
 * `agentPlanTextIssues`, and the section sits after the plan fence.
 */
import type { AppointmentSlot } from '@cti/contracts';

/** How each kind of appointment is named in the list of times. */
export const KIND_WORDS: Readonly<Record<AppointmentSlot['kind'], string>> = { phone: 'phone call', walkthrough: 'walkthrough' };

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
