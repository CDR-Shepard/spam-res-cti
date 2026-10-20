/**
 * Per-tenant outreach settings, read from `organizations.settings` (jsonb).
 *
 * Tolerant by design: a missing or malformed key falls back to its default, so
 * a hand-edited settings blob can never crash a job tick. A malformed
 * `liveChannels` entry (or one that is not implemented yet) is dropped rather than
 * defaulted, so junk can only make FEWER channels live, never more.
 */
import { AiCallBookingSettings, type BookingRouting } from '@cti/contracts';

export const LIVE_CHANNEL_VALUES = ['rep_call', 'ai_call', 'sms', 'email'] as const;
export type LiveChannel = (typeof LIVE_CHANNEL_VALUES)[number];
/**
 * Channels something can actually send on. Phase 1 sends only rep calls (through the
 * dialer); an `ai_call`, `sms`, or `email` entry is ignored so the planner HOLDS those
 * touches instead of emitting a `planned` touch that nothing would ever send. Widen this
 * list in the phase that ships the channel.
 */
export const IMPLEMENTED_CHANNELS: readonly LiveChannel[] = ['rep_call'];

export interface OutreachSettings {
  aiDailyBudgetUsd: number;
  liveChannels: Array<'rep_call' | 'ai_call' | 'sms' | 'email'>;
  consentFromWebForms: boolean;
  consentFromInboundCalls: boolean;
  /** AI call campaigns (plan 1C): live AI calls per tenant at once (1–5). */
  aiCallConcurrency: number;
  /** AI calls placed per tenant per rolling 24 hours (0–500; 0 = none). */
  aiCallDailyCap: number;
  /** Unanswered-call attempts per lead (no answer, busy, voicemail, failed) before it completes (1–5). */
  aiCallMaxAttempts: number;
  /**
   * Plan 1D: write call results back to Salesforce. Off unless explicitly `true` (final review WEB I-2): an admin turns it
   * on in the AI call settings card after the readiness check, a practice call and the one-Lead check.
   */
  aiCallWriteback: boolean;
}

export const DEFAULT_AI_DAILY_BUDGET_USD = 25;
export const DEFAULT_LIVE_CHANNELS: readonly LiveChannel[] = ['rep_call'];
export const DEFAULT_AI_CALL_CONCURRENCY = 2;
export const DEFAULT_AI_CALL_DAILY_CAP = 50;
export const DEFAULT_AI_CALL_MAX_ATTEMPTS = 3;

/**
 * Booking defaults (user decisions): phone 15 min, Mon–Fri, starts every 30 min 10:00–17:30, earliest 2 h ahead, 2 business
 * days; walkthrough 60 min, starts on the hour 9:00–16:00, earliest 20 h ahead, 5 business days, 30 min buffer; up to 6 of
 * each kind offered. `specialists` is empty here: the configured default list fills it (bookingSettings).
 *
 * Final review WEB I-2: booking and Lead conversion are OFF for every tenant until an admin turns them on in the AI call
 * settings card (after the readiness check, a practice call and the one-Lead check), even when AI_CALL_DEFAULT_SPECIALISTS
 * is set: that list only pre-fills the owner. No migration: an absent setting is off.
 */
export const DEFAULT_AI_CALL_BOOKING: Readonly<AiCallBookingSettings> = Object.freeze({
  enabled: false,
  specialists: [],
  convertLeads: false,
  days: [1, 2, 3, 4, 5],
  phone: { enabled: true, durationMinutes: 15, startHour: 10, endHour: 18, stepMinutes: 30, minLeadMinutes: 120, horizonBusinessDays: 2, bufferMinutes: 0, maxOffered: 6 },
  walkthrough: { enabled: true, durationMinutes: 60, startHour: 9, endHour: 17, stepMinutes: 60, minLeadMinutes: 1200, horizonBusinessDays: 5, bufferMinutes: 30, maxOffered: 6 },
} satisfies AiCallBookingSettings);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * Rep routing defaults (the spec's): LA reps start from the office, SD reps from San Diego (owner, 2026-10-20); a seller's county picks the region; each region has its
 * reps in tie-break order and the start times offered each day (Pacific). Counties are matched by name with " County" removed.
 * Frozen all the way down: a caller that needs to change one copies it (`bookingSettings` hands out copies).
 */
export const DEFAULT_BOOKING_ROUTING: Readonly<BookingRouting> = deepFreeze({
  officeAddress: '18872 MacArthur Blvd #220, Irvine, CA 92612',
  regions: [
    {
      key: 'LA',
      counties: ['Los Angeles', 'Orange', 'Riverside', 'San Bernardino'],
      reps: ['0055f000005qXn8AAE', '0058X00000FA8tLQAT'],
      startTimes: ['09:00', '11:00', '13:00', '15:00', '17:00', '19:00'],
    },
    {
      key: 'SD',
      counties: ['San Diego'],
      reps: ['0055f000005qXVfAAM', '0055f000005qYO6AAM'],
      startTimes: ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'],
      startAddress: '7480 Miramar Rd, San Diego, CA',
    },
  ],
} satisfies BookingRouting);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function budgetFrom(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_AI_DAILY_BUDGET_USD;
}

/** An integer in [min, max], else the default: junk can never make AI call pacing more aggressive. */
function intIn(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function isLiveChannel(value: unknown): value is LiveChannel {
  return typeof value === 'string' && (IMPLEMENTED_CHANNELS as readonly string[]).includes(value);
}

function liveChannelsFrom(value: unknown): LiveChannel[] {
  if (!Array.isArray(value)) return [...DEFAULT_LIVE_CHANNELS];
  return [...new Set(value.filter(isLiveChannel))];
}

/** The routing a booking blob uses: its own, or the defaults when it was saved before routing existed. Read-only (the defaults are frozen). */
export function bookingRouting(b: AiCallBookingSettings): BookingRouting {
  return b.routing ?? DEFAULT_BOOKING_ROUTING;
}

/**
 * Plan 1D: the tenant's appointment booking settings (`specialists`: its first active user, the appointment owner, takes high
 * priority; `routing`: the region reps take every other booking). The saved blob when it parses as a whole, else the
 * defaults as a whole (a malformed blob never half-applies). `routing` is always
 * filled in: a blob saved before routing existed keeps everything it had and gets the routing defaults. The configured
 * default list (AI_CALL_DEFAULT_SPECIALISTS) applies only to the defaults: a saved list, even an empty one, always wins.
 * Fix 1 (M-4): this is the only reader of `aiCallBooking`, and the default list is required, so no reader can see an empty
 * list by forgetting it.
 */
export function bookingSettings(org: { settings: unknown }, defaultSpecialists: readonly string[]): AiCallBookingSettings {
  const s = isRecord(org.settings) ? org.settings : {};
  const saved = AiCallBookingSettings.safeParse(s.aiCallBooking);
  if (saved.success) return { ...saved.data, routing: saved.data.routing ?? structuredClone(DEFAULT_BOOKING_ROUTING) };
  return { ...structuredClone(DEFAULT_AI_CALL_BOOKING), specialists: [...defaultSpecialists], routing: structuredClone(DEFAULT_BOOKING_ROUTING) };
}

/**
 * Fix 2: what a REAL call may offer. Booking counts only while write-back is on, so a time a seller is offered and takes always
 * reaches Salesforce (Grant sees it). The settings route refuses to save booking on with write-back off; this is the
 * defensive twin for a blob saved before that rule, or edited by hand. Only the on switch changes. Lead conversion is
 * independent and stays as saved (off: the designed hold plus Task fallback).
 */
export function liveCallBooking(org: { settings: unknown }, defaultSpecialists: readonly string[]): AiCallBookingSettings {
  const b = bookingSettings(org, defaultSpecialists);
  return outreachSettings(org).aiCallWriteback ? b : { ...b, enabled: false };
}

/**
 * Fix 2: what a PRACTICE call offers: the routed offer whenever some region has a rep, whatever the toggles say, so an admin
 * can hear the offer before anything is turned on. A practice call still never books, converts or writes.
 */
export function practiceBooking(org: { settings: unknown }, defaultSpecialists: readonly string[]): AiCallBookingSettings {
  return { ...bookingSettings(org, defaultSpecialists), enabled: true };
}

/**
 * Booking is on and some region has a rep to send. The `specialists` list no longer decides this: it only names the high-priority
 * rep. Whether a rep resolves to an ACTIVE user is checked when the offer is read (`no_reps`).
 */
export function bookingActive(b: AiCallBookingSettings): boolean {
  return b.enabled && bookingRouting(b).regions.some((region) => region.reps.length > 0);
}

export function outreachSettings(org: { settings: unknown }): OutreachSettings {
  const s = isRecord(org.settings) ? org.settings : {};
  return {
    aiDailyBudgetUsd: budgetFrom(s.aiDailyBudgetUsd),
    liveChannels: liveChannelsFrom(s.liveChannels),
    consentFromWebForms: s.consentFromWebForms === true,
    consentFromInboundCalls: s.consentFromInboundCalls === true,
    aiCallConcurrency: intIn(s.aiCallConcurrency, 1, 5, DEFAULT_AI_CALL_CONCURRENCY),
    aiCallDailyCap: intIn(s.aiCallDailyCap, 0, 500, DEFAULT_AI_CALL_DAILY_CAP),
    aiCallMaxAttempts: intIn(s.aiCallMaxAttempts, 1, 5, DEFAULT_AI_CALL_MAX_ATTEMPTS),
    aiCallWriteback: s.aiCallWriteback === true,
  };
}

/** A pause marker that is present but unreadable (junk in a hand-edited blob): still a pause, dated from the epoch. */
const UNREADABLE_PAUSE = new Date(0).toISOString();

export interface SamEmailSettings {
  enabled: boolean;
  /** ISO time Sam's email was paused (a spam complaint, see email/pause.ts); null = not paused. */
  pausedAt: string | null;
  pausedReason: string | null;
}

/**
 * Sam's email channel for the tenant (`settings.samEmail`, written by email/pause.ts and the settings route).
 * Off unless `enabled` is exactly `true`; junk is off. The pause is read the other way round: any non-null
 * `pausedAt` pauses, even an unreadable one, so a mangled blob can only make Sam email LESS.
 */
export function samEmailSettings(org: { settings: unknown }): SamEmailSettings {
  const s = isRecord(org.settings) ? org.settings : {};
  const e = isRecord(s.samEmail) ? s.samEmail : {};
  const pausedAt = e.pausedAt === undefined || e.pausedAt === null ? null : typeof e.pausedAt === 'string' && e.pausedAt !== '' ? e.pausedAt : UNREADABLE_PAUSE;
  return {
    enabled: e.enabled === true,
    pausedAt,
    pausedReason: typeof e.pausedReason === 'string' ? e.pausedReason : null,
  };
}
