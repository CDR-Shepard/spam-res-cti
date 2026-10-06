/**
 * Times AI calls have already booked with the appointment owner that the owner's Salesforce calendar does not show yet
 * (Fix 1, I-4). cti-api stores a booking on `ai_calls.appointment` the moment the agent books it; the write-back creates the
 * Event later (and a fallback creates none). Until an Event exists, the calendar read cannot see the booking, so the next
 * call's offer takes these out itself: concurrent and back-to-back calls are never promised the same time.
 *
 * Read-only (outreach-api never writes ai_calls). Test and practice calls never count: nothing is ever written for them, so
 * their bookings are not real appointments. A booking whose write-back created the Event is the calendar's to show, unless
 * it blocks more than its Event (a walkthrough's travel buffer, `blockStart`): cti-api's booking check still holds that
 * whole block, so the offer must too, or it proposes a time the agent is then told was "just taken" (sweep D-19(a)).
 *
 * Only a booking that stands counts (Part 4 Fix 1, I-1; `bookingStands` in @cti/contracts, the same rule as cti-api's
 * D-10 check): a live call's, or a finished call's whose outcome keeps it (appointment_set, or a transfer). A call that
 * booked and then ended do-not-call, not interested and so on freed the time.
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { BOOKING_STANDS_OUTCOMES, BookedAppointment } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import type { AiCallBookingSettings } from '@cti/contracts';
import { OFFER_CALENDAR_DAYS, offerFrom, type Offer, type OfferCalendar } from './offer.js';
import type { Busy } from './slots.js';

/** A call books one of the times its trigger offered, all within OFFER_CALENDAR_DAYS of the trigger: older calls cannot matter. */
export const BOOKED_LOOKBACK_DAYS = OFFER_CALENDAR_DAYS + 1;
/** Bounds the read; far above what one owner's calendar can hold in the look-back. */
export const BOOKED_ROW_LIMIT = 500;
const DAY_MS = 86_400_000;

/** Salesforce compares ids on their case-sensitive 15-character core. */
const core = (id: string): string => id.slice(0, 15);

/** The owner's booked times overlapping [now, until) that no Event shows yet, as timed busy items. */
export async function bookedNotOnCalendar(db: Db, a: { orgId: string; ownerSfUserId: string; now: Date; until: Date }): Promise<Busy[]> {
  const c = schema.aiCalls;
  const w = schema.aiCallWritebacks;
  const since = new Date(a.now.getTime() - BOOKED_LOOKBACK_DAYS * DAY_MS);
  const rows = await db
    .select({ appointment: c.appointment })
    .from(c)
    .leftJoin(w, eq(w.aiCallId, c.id))
    .where(
      and(
        eq(c.orgId, a.orgId),
        isNotNull(c.appointment),
        eq(c.isTest, false),
        gte(c.createdAt, since),
        or(isNull(w.sfEventId), sql`${c.appointment}->>'blockStart' is not null`),
        or(inArray(c.outcome, [...BOOKING_STANDS_OUTCOMES]), and(isNull(c.outcome), isNull(c.endedAt))),
      ),
    )
    .orderBy(desc(c.createdAt))
    .limit(BOOKED_ROW_LIMIT);
  return rows.flatMap(({ appointment }): Busy[] => {
    const booked = BookedAppointment.safeParse(appointment);
    if (!booked.success || core(booked.data.specialistSfUserId) !== core(a.ownerSfUserId)) return [];
    // The time it blocks (Part 4 Fix 1, I-3): a walkthrough's buffer included, as cti-api's booking check compares it.
    const start = new Date(booked.data.blockStart ?? booked.data.start);
    const end = new Date(booked.data.blockEnd ?? booked.data.end);
    return start.getTime() < a.until.getTime() && end.getTime() > a.now.getTime() ? [{ start, end, allDay: false }] : [];
  });
}

/**
 * The offer from a calendar already read, less the times other AI calls booked with its owner that no Event shows yet
 * (I-4). One composition for the pacer's trigger (pace-context.ts tickOffer) and a practice call (practice.ts), so the
 * admin hears what a seller would be offered (P6 M-2).
 */
export async function offerWithAiBookings(db: Db, cal: OfferCalendar, i: { orgId: string; booking: AiCallBookingSettings; now: Date }): Promise<Offer> {
  const booked = cal.kind === 'read' ? await bookedNotOnCalendar(db, { orgId: i.orgId, ownerSfUserId: cal.owner.sfUserId, now: i.now, until: cal.until }) : [];
  return offerFrom(cal, { booking: i.booking, now: i.now, booked });
}
