/**
 * Per-tenant outreach settings, read from `organizations.settings` (jsonb).
 *
 * Tolerant by design: a missing or malformed key falls back to its default, so
 * a hand-edited settings blob can never crash a job tick. A malformed
 * `liveChannels` entry (or one that is not implemented yet) is dropped rather than
 * defaulted, so junk can only make FEWER channels live, never more.
 */
import { AiCallBookingSettings } from '@cti/contracts';

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
  /** Plan 1D: appointment booking on AI calls (one appointment owner: the first active user on `specialists`). */
  aiCallBooking: AiCallBookingSettings;
  /** Plan 1D: write call results back to Salesforce. On unless explicitly `false`. */
  aiCallWriteback: boolean;
}

export interface OutreachSettingsOptions {
  /** AI_CALL_DEFAULT_SPECIALISTS: the owner list used until the tenant saves `aiCallBooking` (no tenant id in code). */
  defaultSpecialists?: readonly string[];
}

export const DEFAULT_AI_DAILY_BUDGET_USD = 25;
export const DEFAULT_LIVE_CHANNELS: readonly LiveChannel[] = ['rep_call'];
export const DEFAULT_AI_CALL_CONCURRENCY = 2;
export const DEFAULT_AI_CALL_DAILY_CAP = 50;
export const DEFAULT_AI_CALL_MAX_ATTEMPTS = 3;

/**
 * Booking defaults (user decisions): phone 15 min, Mon–Fri, starts every 30 min 10:00–17:30, earliest 2 h ahead, 2 business
 * days; walkthrough 60 min, starts on the hour 9:00–16:00, earliest 20 h ahead, 5 business days, 30 min buffer; up to 6 of
 * each kind offered. `specialists` is empty here: the configured default list fills it (outreachSettings).
 */
export const DEFAULT_AI_CALL_BOOKING: Readonly<AiCallBookingSettings> = Object.freeze({
  enabled: true,
  specialists: [],
  convertLeads: true,
  days: [1, 2, 3, 4, 5],
  phone: { enabled: true, durationMinutes: 15, startHour: 10, endHour: 18, stepMinutes: 30, minLeadMinutes: 120, horizonBusinessDays: 2, bufferMinutes: 0, maxOffered: 6 },
  walkthrough: { enabled: true, durationMinutes: 60, startHour: 9, endHour: 17, stepMinutes: 60, minLeadMinutes: 1200, horizonBusinessDays: 5, bufferMinutes: 30, maxOffered: 6 },
} satisfies AiCallBookingSettings);

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

/**
 * The saved booking settings when they parse as a whole, else the defaults as a whole (a malformed blob never half-applies).
 * The configured default list applies only to the defaults: a saved list, even an empty one, always wins.
 */
function bookingFrom(value: unknown, defaultSpecialists: readonly string[]): AiCallBookingSettings {
  const saved = AiCallBookingSettings.safeParse(value);
  if (saved.success) return saved.data;
  return { ...structuredClone(DEFAULT_AI_CALL_BOOKING), specialists: [...defaultSpecialists] };
}

/** Booking is on and names someone. Whether that list resolves to an ACTIVE user is checked when slots are offered (`no_owner`). */
export function bookingActive(b: AiCallBookingSettings): boolean {
  return b.enabled && b.specialists.length > 0;
}

export function outreachSettings(org: { settings: unknown }, opts: OutreachSettingsOptions = {}): OutreachSettings {
  const s = isRecord(org.settings) ? org.settings : {};
  return {
    aiDailyBudgetUsd: budgetFrom(s.aiDailyBudgetUsd),
    liveChannels: liveChannelsFrom(s.liveChannels),
    consentFromWebForms: s.consentFromWebForms === true,
    consentFromInboundCalls: s.consentFromInboundCalls === true,
    aiCallConcurrency: intIn(s.aiCallConcurrency, 1, 5, DEFAULT_AI_CALL_CONCURRENCY),
    aiCallDailyCap: intIn(s.aiCallDailyCap, 0, 500, DEFAULT_AI_CALL_DAILY_CAP),
    aiCallMaxAttempts: intIn(s.aiCallMaxAttempts, 1, 5, DEFAULT_AI_CALL_MAX_ATTEMPTS),
    aiCallBooking: bookingFrom(s.aiCallBooking, opts.defaultSpecialists ?? []),
    aiCallWriteback: s.aiCallWriteback !== false,
  };
}
