/**
 * Times AI calls have already booked with the region reps that their Salesforce calendars do not show yet (Fix 1, I-4).
 * cti-api stores a booking on `ai_calls.appointment` the moment the agent books it; the write-back creates the Event later
 * (and a fallback creates none). Until an Event exists, the calendar read cannot see the booking, so the next call's offer
 * takes these out itself: concurrent and back-to-back calls are never promised the same time.
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
import { OFFER_CALENDAR_DAYS } from './calendar.js';
import type { Busy } from './slots.js';

/** A call books one of the times its trigger offered, all within OFFER_CALENDAR_DAYS of the trigger: older calls cannot matter. */
export const BOOKED_LOOKBACK_DAYS = OFFER_CALENDAR_DAYS + 1;
/** Bounds the read; far above what the reps' calendars can hold in the look-back. */
export const BOOKED_ROW_LIMIT = 500;
const DAY_MS = 86_400_000;

/** Salesforce compares ids on their case-sensitive 15-character core. */
const core = (id: string): string => id.slice(0, 15);

interface Window {
  now: Date;
  until: Date;
}

/** The tenant's stored bookings that may still hold time (newest first): see the module comment for which count. */
async function standingAppointments(db: Db, orgId: string, now: Date): Promise<unknown[]> {
  const c = schema.aiCalls;
  const w = schema.aiCallWritebacks;
  const since = new Date(now.getTime() - BOOKED_LOOKBACK_DAYS * DAY_MS);
  const rows = await db
    .select({ appointment: c.appointment })
    .from(c)
    .leftJoin(w, eq(w.aiCallId, c.id))
    .where(
      and(
        eq(c.orgId, orgId),
        isNotNull(c.appointment),
        eq(c.isTest, false),
        gte(c.createdAt, since),
        or(isNull(w.sfEventId), sql`${c.appointment}->>'blockStart' is not null`),
        or(inArray(c.outcome, [...BOOKING_STANDS_OUTCOMES]), and(isNull(c.outcome), isNull(c.endedAt))),
      ),
    )
    .orderBy(desc(c.createdAt))
    .limit(BOOKED_ROW_LIMIT);
  return rows.map((r) => r.appointment);
}

/**
 * A stored booking as its rep's busy item over the time it blocks (Part 4 Fix 1, I-3: a walkthrough's buffer included, as
 * cti-api's booking check compares it), or null when it does not parse or misses [now, until). It is a consultation with no
 * place: the routing engine counts it in the rep's load and takes the rep to be at the office around it.
 */
function bookedItem(appointment: unknown, w: Window): { rep: string; busy: Busy } | null {
  const booked = BookedAppointment.safeParse(appointment);
  if (!booked.success) return null;
  const start = new Date(booked.data.blockStart ?? booked.data.start);
  const end = new Date(booked.data.blockEnd ?? booked.data.end);
  if (start.getTime() >= w.until.getTime() || end.getTime() <= w.now.getTime()) return null;
  return { rep: core(booked.data.specialistSfUserId), busy: { start, end, allDay: false, consultation: true, location: null } };
}

/**
 * Each rep's booked times overlapping [now, until) that no Event shows yet, keyed by the rep's 15-character id core. Every
 * rep asked is in the map, with [] when it has none; no rep asked, no query.
 */
export async function bookedNotOnCalendar(db: Db, a: { orgId: string; repSfUserIds: readonly string[]; now: Date; until: Date }): Promise<Map<string, Busy[]>> {
  const reps = [...new Set(a.repSfUserIds.map(core))];
  if (reps.length === 0) return new Map();
  const items = (await standingAppointments(db, a.orgId, a.now)).flatMap((appointment) => bookedItem(appointment, a) ?? []);
  return new Map(reps.map((rep) => [rep, items.filter((i) => i.rep === rep).map((i) => i.busy)]));
}
