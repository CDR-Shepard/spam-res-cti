/**
 * Appointment booking and Salesforce write-back contracts (plan 1D).
 *
 * Slots are computed by outreach-api at trigger time from the appointment
 * owner's calendar and travel as structured data in the signed trigger
 * (`target.slots`), never inside the plan text. cti-api renders them in words.
 */
import { z } from 'zod';

export const AppointmentKind = z.enum(['phone', 'walkthrough']);
export type AppointmentKind = z.infer<typeof AppointmentKind>;

/** p1..p9 for phone slots, w1..w9 for walkthrough slots. */
export const SLOT_ID = /^[pw][1-9]$/;
/** A Salesforce User id (key prefix 005), 15 or 18 characters. */
const SF_USER_ID = /^005[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/;
const IsoInstant = z.string().datetime({ offset: true });

export const IanaZone = z.string().max(64).regex(/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/);
export type IanaZone = z.infer<typeof IanaZone>;

export const AppointmentSlot = z
  .object({
    id: z.string().regex(SLOT_ID),
    kind: AppointmentKind,
    start: IsoInstant,
    end: IsoInstant,
    specialistSfUserId: z.string().regex(SF_USER_ID),
    /** Spoken by the agent ("a quick call with Seth"); cti-api still passes it through oneLine. */
    specialistFirstName: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z][A-Za-z .'-]*$/)
      .nullable(),
    /** The specialist's zone: business hours are in it. */
    timeZone: IanaZone,
  })
  .strict()
  .refine((s) => s.id.startsWith(s.kind === 'phone' ? 'p' : 'w'), { message: 'slot id prefix must match kind' })
  .refine((s) => Date.parse(s.end) > Date.parse(s.start), { message: 'end after start' });
export type AppointmentSlot = z.infer<typeof AppointmentSlot>;

export const AppointmentSlots = z
  .array(AppointmentSlot)
  .max(12)
  .refine((a) => new Set(a.map((s) => s.id)).size === a.length, { message: 'slot ids unique' });
export type AppointmentSlots = z.infer<typeof AppointmentSlots>;

/** What the agent's book_appointment tool stored on ai_calls.appointment (0054). */
export const BookedAppointment = z
  .object({
    slotId: z.string().regex(SLOT_ID),
    kind: AppointmentKind,
    start: IsoInstant,
    end: IsoInstant,
    specialistSfUserId: z.string().regex(SF_USER_ID),
    addressConfirmed: z.boolean(),
    note: z.string().max(300),
    bookedAt: IsoInstant,
  })
  .strict();
export type BookedAppointment = z.infer<typeof BookedAppointment>;

/**
 * The call outcomes under which a booking on `ai_calls.appointment` stands (Part 4 Fix 1, I-1). Booking records
 * `appointment_set` at once; a later do-not-call, wrong number or end_call decision (not interested, a callback instead…)
 * replaces it and frees the time. A transfer keeps it: the seller booked, then also talked to a rep, and the rep can cancel
 * (`qualified_transferred`, and `transfer_failed` when the transfer did not connect).
 */
export const BOOKING_STANDS_OUTCOMES = ['appointment_set', 'qualified_transferred', 'transfer_failed'] as const;

/** Does a call's booking still hold the specialist's time? A live call with no outcome yet holds it too. */
export function bookingStands(call: { outcome: string | null; endedAt: Date | string | null }): boolean {
  if (call.outcome === null) return call.endedAt === null;
  return (BOOKING_STANDS_OUTCOMES as readonly string[]).includes(call.outcome);
}

/** Structured facts about the call cti-api renders outside the plan fence. */
export const CallContext = z.object({ returning: z.boolean() }).strict();
export type CallContext = z.infer<typeof CallContext>;

export const KindSettings = z
  .object({
    enabled: z.boolean(),
    durationMinutes: z.number().int().min(10).max(180),
    startHour: z.number().int().min(6).max(20),
    endHour: z.number().int().min(7).max(22),
    stepMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
    minLeadMinutes: z.number().int().min(0).max(10_080),
    horizonBusinessDays: z.number().int().min(1).max(10),
    bufferMinutes: z.number().int().min(0).max(120),
    maxOffered: z.number().int().min(1).max(6),
  })
  .strict()
  .refine((k) => k.endHour > k.startHour, { message: 'endHour after startHour' });
export type KindSettings = z.infer<typeof KindSettings>;

export const AiCallBookingSettings = z
  .object({
    enabled: z.boolean(),
    /** Ordered. The FIRST ACTIVE user owns every AI-booked slot and Event (decision 1: Grant Golden). No rotation, no owner-first rule. */
    specialists: z.array(z.string().regex(SF_USER_ID)).max(20),
    /** A Lead that books is converted (decision 2). Off → the hold + Task fallback for every Lead booking. */
    convertLeads: z.boolean(),
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    phone: KindSettings,
    walkthrough: KindSettings,
  })
  .strict();
export type AiCallBookingSettings = z.infer<typeof AiCallBookingSettings>;

export const AiCallSettings = z.object({ booking: AiCallBookingSettings, writeback: z.boolean() }).strict();
export type AiCallSettings = z.infer<typeof AiCallSettings>;

export const SalesforceUserOption = z.object({ id: z.string(), name: z.string(), title: z.string().nullable(), isActive: z.boolean() });
export type SalesforceUserOption = z.infer<typeof SalesforceUserOption>;

export const WritebackReadinessProblem = z.enum(['not_updateable', 'missing', 'cannot_create', 'cannot_convert', 'soap_unavailable']);
export type WritebackReadinessProblem = z.infer<typeof WritebackReadinessProblem>;

export const WritebackReadiness = z.object({
  ready: z.boolean(),
  /** Conversion can run: SOAP reachable with the token, Convert Leads permission, Account/Contact/Opportunity createable. */
  convertReady: z.boolean(),
  /** The connected user's default record types (what conversion creates), shown on the card. */
  convertRecordTypes: z.object({ account: z.string().nullable(), opportunity: z.string().nullable() }),
  /** The appointment owner the list resolves to now (first active), or null → booking is off. */
  appointmentOwner: SalesforceUserOption.nullable(),
  items: z.array(
    z.object({ object: z.string(), field: z.string().nullable(), label: z.string(), problem: WritebackReadinessProblem }),
  ),
});
export type WritebackReadiness = z.infer<typeof WritebackReadiness>;
