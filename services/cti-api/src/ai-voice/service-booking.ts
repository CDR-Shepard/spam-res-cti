/**
 * The `book_appointment` tool (plan 1D): the agent books one of the times this call's trigger offered (`ctx.slots`).
 *
 * Only a listed slot id is bookable, a walkthrough needs the property confirmed first, and the booking is written by the
 * `bookAppointment` effect (ai_calls.appointment; outreach-api's write-back makes the Salesforce Event later; a test or
 * practice call's booking is never written anywhere else). A time another AI call already holds with the same owner is
 * refused atomically (D-10, store-booking.ts) and the agent is told to offer another. Every other failure is bookkeeping:
 * logged, never thrown, and the agent falls back to a callback.
 */
import { BookedAppointment, type AppointmentSlot } from '@cti/contracts';
import type { ToolResult } from './bridge.js';
import type { ToolCtx, ToolEnv } from './service-tools.js';

export const WALKTHROUGH_NEEDS_ADDRESS =
  'Confirm the property address with them first (is it the house we are calling about?), then call book_appointment again with address_confirmed true.';
export const SLOT_TAKEN =
  'That time was just taken by someone else — nothing was booked. Apologise briefly and offer them the other time you mentioned, or another time from the list.';
const NOT_LISTED = 'That time is not on your list. Offer one of the listed times.';
const BOOKED =
  'booked — confirm the day and time in one line with your goodbye, then end_call with outcome appointment_set';
const FAILED = 'booking failed — offer to have the specialist call them back instead (schedule_callback)';
const NOTE_MAX = 300;
/** The summary line a booking leaves (summary.ts carries it through rewrites). */
export const BOOKED_LINE_PREFIX = 'Appointment booked:';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const field = (args: unknown, key: string): unknown =>
  args !== null && typeof args === 'object' ? (args as Record<string, unknown>)[key] : undefined;

function bookingFor(slot: AppointmentSlot, args: unknown, now: Date): BookedAppointment {
  const note = field(args, 'note');
  return BookedAppointment.parse({
    slotId: slot.id,
    kind: slot.kind,
    start: slot.start,
    end: slot.end,
    specialistSfUserId: slot.specialistSfUserId,
    addressConfirmed: field(args, 'address_confirmed') === true,
    note: typeof note === 'string' ? note.trim().slice(0, NOTE_MAX) : '',
    bookedAt: now.toISOString(),
    // Fix 1 I-3: the time the slot blocks (its buffer included), for the D-10 check and outreach-api's next offer.
    ...(slot.blockStart !== undefined ? { blockStart: slot.blockStart } : {}),
    ...(slot.blockEnd !== undefined ? { blockEnd: slot.blockEnd } : {}),
  });
}

/**
 * The summary's booking line (M-3): an identical replay adds nothing, and a rebook replaces the earlier line, so the
 * summary only ever names the time that is booked.
 */
async function noteBooking(ctx: ToolCtx, booked: BookedAppointment): Promise<void> {
  const line = `${BOOKED_LINE_PREFIX} ${booked.kind === 'phone' ? 'phone call' : 'walkthrough'} ${booked.start}`;
  const lines = (await ctx.store.get(ctx.aiCallId))?.summary?.split('\n') ?? [];
  if (lines.includes(line)) return;
  if (!lines.some((l) => l.startsWith(BOOKED_LINE_PREFIX))) return ctx.store.appendSummary(ctx.aiCallId, line);
  const kept = lines.filter((l) => !l.startsWith(BOOKED_LINE_PREFIX));
  const at = lines.findIndex((l) => l.startsWith(BOOKED_LINE_PREFIX));
  await ctx.store.update(ctx.aiCallId, { summary: [...kept.slice(0, at), line, ...kept.slice(at)].join('\n') });
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

export async function bookAppointment(args: unknown, env: ToolEnv): Promise<ToolResult> {
  const { ctx, effects } = env;
  const id = field(args, 'slot_id');
  const slot = ctx.slots.find((s) => s.id === id);
  if (!slot) return { output: NOT_LISTED };
  if (slot.kind === 'walkthrough' && field(args, 'address_confirmed') !== true) return { output: WALKTHROUGH_NEEDS_ADDRESS };
  try {
    const result = await effects.bookAppointment(ctx, bookingFor(slot, args, ctx.now()));
    if (result === 'taken') {
      ctx.log.info({ aiCallId: ctx.aiCallId, slotId: slot.id }, 'ai-voice: appointment time already taken');
      return { output: SLOT_TAKEN, then: 'continue' };
    }
    return { output: BOOKED, then: 'continue' };
  } catch (e) {
    ctx.log.error({ aiCallId: ctx.aiCallId, what: 'book_appointment', err: errText(e) }, 'ai-voice: call bookkeeping failed');
    return { output: FAILED };
  }
}
