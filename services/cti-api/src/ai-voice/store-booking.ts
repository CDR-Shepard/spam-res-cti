/**
 * The SQL of booking an appointment slot (plan 1D): `book_appointment` writes the booking to `ai_calls.appointment`.
 *
 * D-10: one owner's time is booked once. Two AI calls may have been offered the same free time (each trigger read the
 * calendar before either booked), so the write takes a transaction-scoped advisory lock on the appointment owner, looks
 * for another REAL call in the org that already holds an overlapping time with that owner, and writes only if there is
 * none. The lock serialises racing bookings for one owner; under READ COMMITTED the second transaction's conflict read
 * runs after the first commits, so it sees that booking.
 *
 * Test and practice calls never block a real booking (nothing is ever written to Salesforce for them, and outreach-api's
 * offer ignores them too: appointments/booked.ts), but a practice call is refused a time a real call holds, as the real
 * call would be. Owner ids compare on their case-sensitive 15-character core, as Salesforce does.
 *
 * Only a booking that stands holds the time (Part 4 Fix 1, I-1; `bookingStands` in @cti/contracts): a live call's, or a
 * finished call's whose outcome is one of BOOKING_STANDS_OUTCOMES. A call that booked and then ended do-not-call, not
 * interested and so on frees it (the row keeps the appointment as a record of what was said).
 */
import { and, eq, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { BOOKING_STANDS_OUTCOMES, BookedAppointment } from '@cti/contracts';
import { getDb, schema } from '@cti/db';

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Conn = Db | Tx;

const t = schema.aiCalls;
/** A call books one of the times its trigger offered (at most ~15 days out): older calls cannot hold a conflicting time. */
export const BOOKING_LOOKBACK_DAYS = 30;

export type SetAppointmentResult = 'booked' | 'taken' | 'not_live';

const ownerCore = (sfUserId: string): string => sfUserId.slice(0, 15);

/** Serialise bookings for one owner until the transaction ends. */
export const appointmentLockQuery = (sfUserId: string): SQL =>
  sql`select pg_advisory_xact_lock(hashtextextended(${`ai_call_appointment:${ownerCore(sfUserId)}`}, 0))`;

/** SQL for `bookingStands`: a live row with no outcome yet, or an outcome that keeps the booking. */
const standsSql = (): SQL =>
  sql`(${t.outcome} in (${sql.join(BOOKING_STANDS_OUTCOMES.map((o) => sql`${o}`), sql`, `)}) or (${t.outcome} is null and ${t.endedAt} is null))`;

/**
 * Another real call in this call's org whose standing booking with the same owner overlaps this one. Each booking is
 * compared by the time it blocks (Fix 1, I-3): [blockStart, blockEnd) when its slot carried one (a walkthrough's travel
 * buffer), else [start, end). So two walkthroughs keep their buffers apart, and back-to-back phone calls both book.
 */
export const appointmentConflictQuery = (db: Conn, id: string, a: BookedAppointment) =>
  db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        sql`${t.orgId} = (select "org_id" from "ai_calls" "self" where "self"."id" = ${id})`,
        ne(t.id, id),
        sql`${t.isTest} = false`,
        isNotNull(t.appointment),
        standsSql(),
        sql`${t.createdAt} >= now() - make_interval(days => ${BOOKING_LOOKBACK_DAYS})`,
        sql`left(${t.appointment}->>'specialistSfUserId', 15) = ${ownerCore(a.specialistSfUserId)}`,
        sql`coalesce(${t.appointment}->>'blockStart', ${t.appointment}->>'start')::timestamptz < ${a.blockEnd ?? a.end}::timestamptz`,
        sql`coalesce(${t.appointment}->>'blockEnd', ${t.appointment}->>'end')::timestamptz > ${a.blockStart ?? a.start}::timestamptz`,
      ),
    )
    .limit(1);

/**
 * The booking, on a live row only (a later booking in the same call replaces it), and `appointment_set` in the same
 * statement (sweep D-19(b)): a separate outcome write could fail on its own, and finalize would then derive an outcome
 * that frees the booking. A do-not-call outcome is never replaced (store.setOutcome's rule).
 */
export const setAppointmentQuery = (db: Conn, id: string, a: BookedAppointment) =>
  db
    .update(t)
    .set({
      appointment: sql`${JSON.stringify(a)}::jsonb`,
      outcome: sql`case when ${t.outcome} = 'do_not_call' then ${t.outcome} else 'appointment_set' end`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(t.id, id), isNull(t.endedAt)))
    .returning({ id: t.id });

/** Book `a` for call `id`, atomically refusing a time another real call already holds with the same owner. */
export async function setAppointment(db: Db, id: string, a: BookedAppointment): Promise<SetAppointmentResult> {
  const booking = BookedAppointment.parse(a);
  return db.transaction(async (tx) => {
    await tx.execute(appointmentLockQuery(booking.specialistSfUserId));
    if ((await appointmentConflictQuery(tx, id, booking)).length > 0) return 'taken';
    return (await setAppointmentQuery(tx, id, booking)).length > 0 ? 'booked' : 'not_live';
  });
}
