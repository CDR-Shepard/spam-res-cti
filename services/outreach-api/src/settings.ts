/**
 * Per-tenant outreach settings, read from `organizations.settings` (jsonb).
 *
 * Tolerant by design: a missing or malformed key falls back to its default, so
 * a hand-edited settings blob can never crash a job tick. A malformed
 * `liveChannels` entry (or one that is not implemented yet) is dropped rather than
 * defaulted, so junk can only make FEWER channels live, never more.
 */
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
}

export const DEFAULT_AI_DAILY_BUDGET_USD = 25;
export const DEFAULT_LIVE_CHANNELS: readonly LiveChannel[] = ['rep_call'];
export const DEFAULT_AI_CALL_CONCURRENCY = 2;
export const DEFAULT_AI_CALL_DAILY_CAP = 50;
export const DEFAULT_AI_CALL_MAX_ATTEMPTS = 3;

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
  };
}
