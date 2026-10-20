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

/** Region start times, high-priority hours and Sam's "9 AM" are all read in this zone, on both sides of daylight saving. */
export const ROUTING_ZONE = 'America/Los_Angeles';
/** Every consultation, in person or by phone, is booked for this long. */
export const CONSULTATION_MINUTES = 60;
/** The one id a high-priority booking has; offers are p1..p9 / w1..w9. */
export const PRIORITY_SLOT_ID = 'h1';
/**
 * When a high-priority booking may start, in ROUTING_ZONE: at least `minLeadMinutes` and at most `maxAheadDays` from now, on a
 * `stepMinutes` boundary, from `firstStartHour` and ending by `endByHour`. `defaultStartHour` is the time offered when the
 * seller names none.
 */
export const PRIORITY_RULES = {
  minLeadMinutes: 120,
  maxAheadDays: 14,
  firstStartHour: 8,
  endByHour: 20,
  defaultStartHour: 9,
  stepMinutes: 15,
} as const;

/** A booking region's short code ("LA", "SD"). */
export const RegionKey = z.string().regex(/^[A-Z]{2,6}$/);
export type RegionKey = z.infer<typeof RegionKey>;

/** Spoken by the agent ("a quick call with Seth"); cti-api still passes it through oneLine. */
const SpecialistFirstName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z][A-Za-z .'-]*$/);

export const AppointmentSlot = z
  .object({
    id: z.string().regex(SLOT_ID),
    kind: AppointmentKind,
    start: IsoInstant,
    end: IsoInstant,
    specialistSfUserId: z.string().regex(SF_USER_ID),
    specialistFirstName: SpecialistFirstName.nullable(),
    /** The specialist's zone: business hours are in it. */
    timeZone: IanaZone,
    /** The region the slot was routed through (booking.routing). Absent on a slot from the old specialist-calendar path. */
    region: RegionKey.optional(),
    /**
     * Part 4 Fix 1 (I-3): the time the slot blocks on the specialist's calendar, its kind's buffer included (a walkthrough's
     * travel time; a phone call has none, and then these are absent). Optional, so a slot from an older outreach-api still
     * parses; absent means [start, end).
     */
    blockStart: IsoInstant.optional(),
    blockEnd: IsoInstant.optional(),
  })
  .strict()
  .refine((s) => s.id.startsWith(s.kind === 'phone' ? 'p' : 'w'), { message: 'slot id prefix must match kind' })
  .refine((s) => Date.parse(s.end) > Date.parse(s.start), { message: 'end after start' })
  .refine((s) => s.blockStart === undefined || Date.parse(s.blockStart) <= Date.parse(s.start), { message: 'blockStart at or before start' })
  .refine((s) => s.blockEnd === undefined || Date.parse(s.blockEnd) >= Date.parse(s.end), { message: 'blockEnd at or after end' });
export type AppointmentSlot = z.infer<typeof AppointmentSlot>;

export const AppointmentSlots = z
  .array(AppointmentSlot)
  .max(12)
  .refine((a) => new Set(a.map((s) => s.id)).size === a.length, { message: 'slot ids unique' });
export type AppointmentSlots = z.infer<typeof AppointmentSlots>;

/**
 * Sam may book a "high priority" consultation outside the offered slots (a seller who wants someone today or tomorrow): the
 * first active specialist takes it, at any start PRIORITY_RULES allows. This carries who that is and the default start Sam
 * suggests when the seller names no time, so cti-api can tell Sam without computing anything.
 */
export const PriorityOffer = z
  .object({
    specialistSfUserId: z.string().regex(SF_USER_ID),
    specialistFirstName: SpecialistFirstName.nullable(),
    timeZone: IanaZone,
    defaultStart: IsoInstant,
  })
  .strict();
export type PriorityOffer = z.infer<typeof PriorityOffer>;

/**
 * One consultation the seller already has (or had), as Sam may say it. `ownerName` is spoken and goes into the prompt, so it
 * is held to name characters only: no digits, '#', or newlines.
 */
export const ConsultationFact = z
  .object({
    start: IsoInstant,
    kind: z.enum(['in_person', 'phone']),
    ownerName: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z][A-Za-z .'-]*$/)
      .nullable(),
  })
  .strict();
export type ConsultationFact = z.infer<typeof ConsultationFact>;

/** The seller's most recent past consultation and next upcoming one, either of which may not exist. */
export const Consultations = z.object({ last: ConsultationFact.nullable(), next: ConsultationFact.nullable() }).strict();
export type Consultations = z.infer<typeof Consultations>;

/**
 * What the agent's book_appointment or book_priority_appointment tool stored on ai_calls.appointment (0055). A high-priority
 * booking has slotId 'h1' and `priority: true`; cti-api enforces that pairing (booking-pairing.ts; no `.refine` here: this
 * is used as a plain object schema elsewhere).
 */
export const BookedAppointment = z
  .object({
    slotId: z.string().regex(/^(?:[pw][1-9]|h1)$/),
    kind: AppointmentKind,
    start: IsoInstant,
    end: IsoInstant,
    specialistSfUserId: z.string().regex(SF_USER_ID),
    addressConfirmed: z.boolean(),
    note: z.string().max(300),
    bookedAt: IsoInstant,
    /** Part 4 Fix 1 (I-3): copied from the slot. Absent on older bookings, and then [start, end) is what it blocks. */
    blockStart: IsoInstant.optional(),
    blockEnd: IsoInstant.optional(),
    /** The region the slot was routed through, copied from the slot. */
    region: RegionKey.optional(),
    /** High-priority booking (slotId 'h1'): only ever true. */
    priority: z.literal(true).optional(),
    /** Any booking (book_appointment or high priority): what changed since the seller's earlier consultation, in Sam's words. */
    whatChanged: z.string().max(300).optional(),
    /** Any booking (book_appointment or high priority): the consultation this one follows up on, when the seller had one. */
    previousConsultation: ConsultationFact.optional(),
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
export const CallContext = z.object({ returning: z.boolean(), consultations: Consultations.optional() }).strict();
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

const StartTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

/** "HH:MM" strings are zero-padded, so string order is time order. */
function strictlyAscending(times: readonly string[]): boolean {
  return times.every((t, i) => i === 0 || (times[i - 1] as string) < t);
}

const normalCounty = (county: string): string => county.trim().toLowerCase();

/** No county in two regions: a seller's county must pick exactly one. (Repeating a county inside one region is harmless.) */
function countiesInOneRegion(regions: readonly { counties: readonly string[] }[]): boolean {
  const seen = new Set<string>();
  for (const region of regions) {
    const mine = new Set(region.counties.map(normalCounty));
    if ([...mine].some((c) => seen.has(c))) return false;
    for (const c of mine) seen.add(c);
  }
  return true;
}

const StartAddress = z.string().trim().min(10).max(200);

/**
 * One booking region: the counties it covers, the reps who take its consultations, and the start times offered each day (in
 * ROUTING_ZONE). `reps` may be empty while an admin is still setting a region up; routing then offers nothing for it.
 * `startAddress` is where the region's reps start their day; without one they start from the routing's `officeAddress`.
 */
export const BookingRegion = z
  .object({
    key: RegionKey,
    counties: z.array(z.string().trim().min(2).max(40)).min(1).max(12),
    reps: z.array(z.string().regex(SF_USER_ID)).max(6),
    startTimes: z.array(StartTime).min(1).max(24).refine(strictlyAscending, { message: 'start times strictly ascending' }),
    startAddress: StartAddress.optional(),
  })
  .strict();
export type BookingRegion = z.infer<typeof BookingRegion>;

/** Rep-per-region booking: a rep drives from their region's `startAddress`, else `officeAddress`; a seller's county picks the region. */
export const BookingRouting = z
  .object({
    officeAddress: StartAddress,
    regions: z.array(BookingRegion).min(1).max(6),
  })
  .strict()
  .refine((r) => new Set(r.regions.map((g) => g.key)).size === r.regions.length, { message: 'region keys unique' })
  .refine((r) => countiesInOneRegion(r.regions), { message: 'a county belongs to one region' });
export type BookingRouting = z.infer<typeof BookingRouting>;

/** Where the reps of region `key` start their day: the region's own start address, else the office (also for an unknown key). */
export function regionStartAddress(routing: BookingRouting, key: string | undefined): string {
  return routing.regions.find((r) => r.key === key)?.startAddress ?? routing.officeAddress;
}

export const AiCallBookingSettings = z
  .object({
    enabled: z.boolean(),
    /**
     * Ordered. The FIRST ACTIVE user (Grant Golden) is the appointment owner: the high-priority rep, and the owner of what a
     * Lead conversion creates. Every other booking goes to its region's reps (`routing`). No rotation, no owner-first rule.
     */
    specialists: z.array(z.string().regex(SF_USER_ID)).max(20),
    /** A Lead that books is converted (decision 2). Off → the hold + Task fallback for every Lead booking. */
    convertLeads: z.boolean(),
    /** ISO weekdays (1 Monday … 7 Sunday), each once (sweep D-8). */
    days: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((d) => new Set(d).size === d.length, { message: 'each day once' }),
    phone: KindSettings,
    walkthrough: KindSettings,
    /** Optional so a blob saved before routing existed still parses (a failed parse falls back to the defaults, booking OFF). */
    routing: BookingRouting.optional(),
  })
  .strict();
export type AiCallBookingSettings = z.infer<typeof AiCallBookingSettings>;

export const AiCallSettings = z.object({ booking: AiCallBookingSettings, writeback: z.boolean() }).strict();
export type AiCallSettings = z.infer<typeof AiCallSettings>;

export const SalesforceUserOption = z.object({ id: z.string(), name: z.string(), title: z.string().nullable(), isActive: z.boolean() });
export type SalesforceUserOption = z.infer<typeof SalesforceUserOption>;

/**
 * What the settings card shows about rep routing: the office, whether Google Maps is configured, and each region's reps by name
 * and where they start their day (`regionStartAddress`).
 */
export const RoutingReadiness = z.object({
  officeAddress: z.string(),
  mapsConfigured: z.boolean(),
  regions: z.array(
    z.object({
      key: RegionKey,
      counties: z.array(z.string()),
      startTimes: z.array(z.string()),
      startAddress: z.string(),
      reps: z.array(SalesforceUserOption),
    }),
  ),
});
export type RoutingReadiness = z.infer<typeof RoutingReadiness>;

export const WritebackReadinessProblem = z.enum(['not_updateable', 'missing', 'cannot_create', 'cannot_convert', 'soap_unavailable']);
export type WritebackReadinessProblem = z.infer<typeof WritebackReadinessProblem>;

export const WritebackReadiness = z.object({
  ready: z.boolean(),
  /** Conversion can run: SOAP reachable with the token, Convert Leads permission, Account/Contact/Opportunity createable. */
  convertReady: z.boolean(),
  /** The connected user's default record types (what conversion creates), shown on the card. */
  convertRecordTypes: z.object({ account: z.string().nullable(), opportunity: z.string().nullable() }),
  /** The appointment owner the list resolves to now (first active), or null → no high-priority offer (region bookings go on). */
  appointmentOwner: SalesforceUserOption.nullable(),
  items: z.array(
    z.object({ object: z.string(), field: z.string().nullable(), label: z.string(), problem: WritebackReadinessProblem }),
  ),
  /** Null or absent when routing is not set up (and from an older outreach-api). */
  routing: RoutingReadiness.nullable().optional(),
});
export type WritebackReadiness = z.infer<typeof WritebackReadiness>;
