/**
 * The `book_appointment` tool (plan 1D): the agent books one of the times this call's trigger offered (`ctx.slots`).
 *
 * Only a listed slot id is bookable, a walkthrough needs the property confirmed first, and the booking is written by the
 * `bookAppointment` effect (ai_calls.appointment; outreach-api's write-back makes the Salesforce Event later; a test or
 * practice call's booking is never written anywhere else). A time another AI call already holds with the same owner is
 * refused atomically (D-10, store-booking.ts) and the agent is told to offer another. Every other failure is bookkeeping:
 * logged, never thrown, and the agent falls back to a callback.
 *
 * Routing step 1: `book_priority_appointment` books a high-priority in-person consultation with the call's priority rep
 * (`ctx.priority`) at the time the seller asks for, within PRIORITY_RULES; D-10 does not apply to it. Either booking
 * carries the seller's earlier consultation (`ctx.consultations.last`) and what they say changed since. Logs carry ids,
 * slot ids and codes only: never the reason, what changed, the note, or an address.
 */
import {
  BookedAppointment,
  CONSULTATION_MINUTES,
  PRIORITY_RULES,
  PRIORITY_SLOT_ID,
  ROUTING_ZONE,
  type AppointmentSlot,
  type ConsultationFact,
  type PriorityOffer,
} from '@cti/contracts';
import type { ToolResult } from './bridge.js';
import { wallTimeToDate } from './local-time.js';
import type { ToolCtx, ToolEnv } from './service-tools.js';

export const WALKTHROUGH_NEEDS_ADDRESS =
  'Confirm the property address with them first (is it the house we are calling about?), then call book_appointment again with address_confirmed true.';
export const SLOT_TAKEN =
  'That time was just taken by someone else — nothing was booked. Apologise briefly and offer them the other time you mentioned, or another time from the list.';
export const PRIORITY_UNAVAILABLE = "High-priority booking isn't available on this call — nothing was booked. Offer the listed times or a callback.";
export const PRIORITY_NEEDS_ADDRESS =
  'Confirm the property address with them first, then call book_priority_appointment again with address_confirmed true.';
export const PRIORITY_BAD_TIME =
  "That time couldn't be read — nothing was booked. Use the date and a time on the quarter hour, in Pacific time, like 2026-10-21T14:00.";
export const PRIORITY_TOO_SOON = "That's less than two hours away — nothing was booked. Offer a time at least two hours from now.";
export const PRIORITY_TOO_FAR =
  "That's more than two weeks away — nothing was booked. Check the date with them; for a later time, offer to have the team call them back (schedule_callback).";
export const PRIORITY_OUTSIDE_HOURS =
  'The visit has to start at 8 AM or later and finish by 8 PM (latest start 7 PM), any day — nothing was booked. Offer a time in that range.';
const NOT_LISTED = 'That time is not on your list. Offer one of the listed times.';
const PASSED = 'That time has already passed (or is only minutes away) — nothing was booked. Offer a later time from the list.';
/** A slot starting sooner than this is refused as passed (final review m2): nobody can be ready for it. */
const MIN_LEAD_MS = 5 * 60_000;
const PT_ZONE = 'America/Los_Angeles';
const PT_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: PT_ZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
const BOOKED =
  'booked — confirm the day and time in one line with your goodbye, then end_call with outcome appointment_set';
const FAILED = 'booking failed — offer to have the specialist call them back instead (schedule_callback)';
const NOTE_MAX = 300;
const WHAT_CHANGED_MAX = 300;
/** A high-priority start exactly as the tool asks for it: a Pacific wall-clock time, no seconds, no zone. */
const LOCAL_START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** A sentence already ends: a stop, `?`, `!` or an ellipsis, maybe inside a closing quote. */
const SENTENCE_END = /[.!?…]["'”’]?$/;
/** The summary line a booking leaves (summary.ts carries it through rewrites). */
export const BOOKED_LINE_PREFIX = 'Appointment booked:';
const KIND_WORDS = { phone: 'phone consultation', walkthrough: 'in-person consultation' } as const;
const PRIORITY_WORDS = 'high-priority in-person consultation';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const field = (args: unknown, key: string): unknown =>
  args !== null && typeof args === 'object' ? (args as Record<string, unknown>)[key] : undefined;
const trimmed = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const flat = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/** What either booking carries about the seller's earlier consultation: what changed (left out when empty) and that consultation. */
function followUp(args: unknown, ctx: ToolCtx): { whatChanged?: string; previousConsultation?: ConsultationFact } {
  const whatChanged = trimmed(field(args, 'what_changed'), WHAT_CHANGED_MAX);
  const previous = ctx.consultations?.last ?? null;
  return { ...(whatChanged ? { whatChanged } : {}), ...(previous !== null ? { previousConsultation: previous } : {}) };
}

function bookingFor(slot: AppointmentSlot, args: unknown, ctx: ToolCtx): BookedAppointment {
  return BookedAppointment.parse({
    slotId: slot.id,
    kind: slot.kind,
    start: slot.start,
    end: slot.end,
    specialistSfUserId: slot.specialistSfUserId,
    addressConfirmed: field(args, 'address_confirmed') === true,
    note: trimmed(field(args, 'note'), NOTE_MAX),
    bookedAt: ctx.now().toISOString(),
    // Fix 1 I-3: the time the slot blocks (its buffer included), for the D-10 check and outreach-api's next offer.
    ...(slot.blockStart !== undefined ? { blockStart: slot.blockStart } : {}),
    ...(slot.blockEnd !== undefined ? { blockEnd: slot.blockEnd } : {}),
    ...(slot.region !== undefined ? { region: slot.region } : {}),
    ...followUp(args, ctx),
  });
}

/**
 * "Wed Oct 7, 11:00 AM PT" (final review m1): the booking line reaches the rep's Salesforce Task, so it is said in the
 * specialists' Pacific time, the same words outreach-api's write-back uses (`ptWords`), never a UTC instant.
 */
export function ptWords(at: Date): string {
  const p: Record<string, string> = {};
  for (const part of PT_PARTS.formatToParts(at)) if (part.type !== 'literal') p[part.type] = part.value;
  return `${p.weekday} ${p.month} ${p.day}, ${p.hour}:${p.minute} ${p.dayPeriod} PT`;
}

/**
 * The summary's booking line (M-3): an identical replay adds nothing, and a rebook replaces the earlier line, so the
 * summary only ever names the time that is booked.
 */
async function noteBooking(ctx: ToolCtx, booked: BookedAppointment): Promise<void> {
  const line = bookedLine(ctx, booked);
  const lines = (await ctx.store.get(ctx.aiCallId))?.summary?.split('\n') ?? [];
  if (lines.includes(line)) return;
  if (!lines.some((l) => l.startsWith(BOOKED_LINE_PREFIX))) return ctx.store.appendSummary(ctx.aiCallId, line);
  const kept = lines.filter((l) => !l.startsWith(BOOKED_LINE_PREFIX));
  const at = lines.findIndex((l) => l.startsWith(BOOKED_LINE_PREFIX));
  await ctx.store.update(ctx.aiCallId, { summary: [...kept.slice(0, at), line, ...kept.slice(at)].join('\n') });
}

/** "Appointment booked: in-person consultation with Blake Thu Oct 8, 9:00 AM PT": the rep is the slot's, or the priority rep. */
function bookedLine(ctx: ToolCtx, booked: BookedAppointment): string {
  const first = booked.priority
    ? ctx.priority?.specialistFirstName
    : ctx.slots.find((s) => s.id === booked.slotId)?.specialistFirstName;
  const kind = booked.priority ? PRIORITY_WORDS : KIND_WORDS[booked.kind];
  return `${BOOKED_LINE_PREFIX} ${kind}${first ? ` with ${first}` : ''} ${ptWords(new Date(booked.start))}`;
}

/** Logged, never thrown: the booking itself is stored, so the agent must still hear that it is booked. */
async function afterBooked(ctx: ToolCtx, what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    ctx.log.warn({ aiCallId: ctx.aiCallId, what, err: errText(e) }, 'ai-voice: booking stored, but its bookkeeping failed');
  }
}

/**
 * The `bookAppointment` effect: store the booking (D-10: refused when another real call holds the time). The same write
 * records `appointment_set` (I-1; one statement since sweep D-19(b)), so a call that ends without
 * end_call(appointment_set) — the caller hangs up, the time limit — still ends booked. A later do-not-call, transfer or
 * end_call decision replaces that outcome (do_not_call is never overridden); see BOOKING_STANDS_OUTCOMES for which keep
 * the booking.
 */
export async function storeBooking(ctx: ToolCtx, booked: BookedAppointment): Promise<'booked' | 'taken'> {
  const result = await ctx.store.setAppointment(ctx.aiCallId, booked);
  if (result === 'not_live') throw new Error('the call is no longer live');
  if (result === 'taken') return 'taken';
  await afterBooked(ctx, 'booking_summary', () => noteBooking(ctx, booked));
  return 'booked';
}

/**
 * Store the booking and say how it went: booked, `taken()` when the store refused the time, or the callback fallback when
 * anything throws (building the booking included). Never throws.
 */
async function storeAndAnswer(env: ToolEnv, what: string, booking: () => BookedAppointment, taken: () => ToolResult): Promise<ToolResult> {
  const { ctx, effects } = env;
  try {
    return (await effects.bookAppointment(ctx, booking())) === 'taken' ? taken() : { output: BOOKED, then: 'continue' };
  } catch (e) {
    ctx.log.error({ aiCallId: ctx.aiCallId, what, err: errText(e) }, 'ai-voice: call bookkeeping failed');
    return { output: FAILED };
  }
}

export async function bookAppointment(args: unknown, env: ToolEnv): Promise<ToolResult> {
  const { ctx } = env;
  const id = field(args, 'slot_id');
  const slot = ctx.slots.find((s) => s.id === id);
  if (!slot) return { output: NOT_LISTED };
  if (Date.parse(slot.start) <= ctx.now().getTime() + MIN_LEAD_MS) return { output: PASSED };
  if (slot.kind === 'walkthrough' && field(args, 'address_confirmed') !== true) return { output: WALKTHROUGH_NEEDS_ADDRESS };
  return storeAndAnswer(env, 'book_appointment', () => bookingFor(slot, args, ctx), () => {
    ctx.log.info({ aiCallId: ctx.aiCallId, slotId: slot.id }, 'ai-voice: appointment time already taken');
    return { output: SLOT_TAKEN, then: 'continue' };
  });
}

/** "Urgent: <reason>. <note>", one line of at most 300 characters (no added full stop when the reason already ends a sentence). */
function urgentNote(args: unknown): string {
  const reason = flat(field(args, 'reason'));
  const head = reason ? `Urgent: ${reason}` : 'Urgent';
  const sentence = SENTENCE_END.test(head) ? head : `${head}.`;
  const note = flat(field(args, 'note'));
  return (note ? `${sentence} ${note}` : sentence).slice(0, NOTE_MAX).trim();
}

/** The start's minutes after local midnight, from its wall-clock "HH:MM" (Pacific: PRIORITY_RULES' hours are wall-clock). */
const wallMinutes = (local: string): number => Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));

/** The checks, in order: the refusal Sam hears with its log code, or the start as an instant and the priority rep. */
function priorityStart(args: unknown, ctx: ToolCtx): { refusal: string; code: string } | { start: Date; rep: PriorityOffer } {
  const rep = ctx.priority;
  if (rep === null) return { refusal: PRIORITY_UNAVAILABLE, code: 'unavailable' };
  if (field(args, 'address_confirmed') !== true) return { refusal: PRIORITY_NEEDS_ADDRESS, code: 'needs_address' };
  const local = field(args, 'start');
  const start = typeof local === 'string' && LOCAL_START.test(local) ? wallTimeToDate(local, ROUTING_ZONE) : null;
  if (typeof local !== 'string' || start === null || wallMinutes(local) % PRIORITY_RULES.stepMinutes !== 0) {
    return { refusal: PRIORITY_BAD_TIME, code: 'bad_time' };
  }
  const ahead = start.getTime() - ctx.now().getTime();
  if (ahead < PRIORITY_RULES.minLeadMinutes * MINUTE_MS) return { refusal: PRIORITY_TOO_SOON, code: 'too_soon' };
  if (ahead > PRIORITY_RULES.maxAheadDays * DAY_MS) return { refusal: PRIORITY_TOO_FAR, code: 'too_far' };
  const from = wallMinutes(local);
  if (from < PRIORITY_RULES.firstStartHour * 60 || from + CONSULTATION_MINUTES > PRIORITY_RULES.endByHour * 60) {
    return { refusal: PRIORITY_OUTSIDE_HOURS, code: 'outside_hours' };
  }
  return { start, rep };
}

/** The high-priority booking: slot h1, in person with the address confirmed, an hour with the priority rep. */
function priorityBookingFor(start: Date, rep: PriorityOffer, args: unknown, ctx: ToolCtx): BookedAppointment {
  return BookedAppointment.parse({
    slotId: PRIORITY_SLOT_ID,
    kind: 'walkthrough',
    start: start.toISOString(),
    end: new Date(start.getTime() + CONSULTATION_MINUTES * MINUTE_MS).toISOString(),
    specialistSfUserId: rep.specialistSfUserId,
    addressConfirmed: true,
    note: urgentNote(args),
    bookedAt: ctx.now().toISOString(),
    priority: true,
    ...followUp(args, ctx),
  });
}

export async function bookPriorityAppointment(args: unknown, env: ToolEnv): Promise<ToolResult> {
  const { ctx } = env;
  const checked = priorityStart(args, ctx);
  if ('refusal' in checked) {
    ctx.log.info({ aiCallId: ctx.aiCallId, slotId: PRIORITY_SLOT_ID, refused: checked.code }, 'ai-voice: high-priority booking refused');
    return { output: checked.refusal };
  }
  return storeAndAnswer(env, 'book_priority_appointment', () => priorityBookingFor(checked.start, checked.rep, args, ctx), () => {
    // The store never refuses a high-priority time (D-10 is skipped for it), so this is a fault, not a clash: SLOT_TAKEN's
    // "another time from the list" would not fit.
    ctx.log.error({ aiCallId: ctx.aiCallId, slotId: PRIORITY_SLOT_ID }, 'ai-voice: high-priority booking answered taken; nothing was booked');
    return { output: FAILED };
  });
}
