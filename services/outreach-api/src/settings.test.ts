import { describe, expect, it } from 'vitest';
import { AiCallBookingSettings } from '@cti/contracts';
import {
  bookingActive,
  DEFAULT_AI_CALL_BOOKING,
  DEFAULT_AI_CALL_CONCURRENCY,
  DEFAULT_AI_CALL_DAILY_CAP,
  DEFAULT_AI_CALL_MAX_ATTEMPTS,
  outreachSettings,
  type OutreachSettings,
} from './settings.js';

const DEFAULTS: OutreachSettings = {
  aiDailyBudgetUsd: 25,
  liveChannels: ['rep_call'],
  consentFromWebForms: false,
  consentFromInboundCalls: false,
  aiCallConcurrency: 2,
  aiCallDailyCap: 50,
  aiCallMaxAttempts: 3,
  aiCallBooking: {
    enabled: true,
    specialists: [],
    convertLeads: true,
    days: [1, 2, 3, 4, 5],
    phone: { enabled: true, durationMinutes: 15, startHour: 10, endHour: 18, stepMinutes: 30, minLeadMinutes: 120, horizonBusinessDays: 2, bufferMinutes: 0, maxOffered: 6 },
    walkthrough: { enabled: true, durationMinutes: 60, startHour: 9, endHour: 17, stepMinutes: 60, minLeadMinutes: 1200, horizonBusinessDays: 5, bufferMinutes: 30, maxOffered: 6 },
  },
  aiCallWriteback: true,
};
const GRANT = '0058X00000Fsx39QAB';
const OTHER = '0058X00000Abcd1QAB';

describe('outreachSettings', () => {
  it.each([
    ['an empty object', {}],
    ['null', null],
    ['a string', 'oops'],
    ['an array', ['rep_call']],
    ['a number', 42],
  ])('returns the defaults for %s', (_label, settings) => {
    expect(outreachSettings({ settings })).toEqual(DEFAULTS);
  });

  it('reads every valid key', () => {
    const settings = { aiDailyBudgetUsd: 40.5, liveChannels: ['rep_call', 'sms'], consentFromWebForms: true, consentFromInboundCalls: true, smsMode: 'x' };
    expect(outreachSettings({ settings })).toEqual({ ...DEFAULTS, aiDailyBudgetUsd: 40.5, liveChannels: ['rep_call'], consentFromWebForms: true, consentFromInboundCalls: true });
  });

  it.each([
    ['a negative budget', { aiDailyBudgetUsd: -1 }, { aiDailyBudgetUsd: 25 }],
    ['a string budget', { aiDailyBudgetUsd: '30' }, { aiDailyBudgetUsd: 25 }],
    ['an infinite budget', { aiDailyBudgetUsd: Number.POSITIVE_INFINITY }, { aiDailyBudgetUsd: 25 }],
    ['a zero budget (AI off)', { aiDailyBudgetUsd: 0 }, { aiDailyBudgetUsd: 0 }],
    ['liveChannels that is not an array', { liveChannels: 'sms' }, { liveChannels: ['rep_call'] }],
    ['unknown and duplicate channels', { liveChannels: ['SMS', 'rep_call', 7, 'rep_call', 'fax'] }, { liveChannels: ['rep_call'] }],
    ['channels that are not implemented yet (phase 1: only rep_call is live)', { liveChannels: ['rep_call', 'ai_call', 'sms', 'email'] }, { liveChannels: ['rep_call'] }],
    ['only not-yet-implemented channels', { liveChannels: ['sms', 'email', 'ai_call'] }, { liveChannels: [] }],
    ['an empty channel list (everything off)', { liveChannels: [] }, { liveChannels: [] }],
    ['string booleans', { consentFromWebForms: 'true', consentFromInboundCalls: 1 }, { consentFromWebForms: false, consentFromInboundCalls: false }],
  ])('tolerates %s', (_label, settings, expected) => {
    expect(outreachSettings({ settings })).toEqual({ ...DEFAULTS, ...expected });
  });

  it('returns a fresh liveChannels array each call', () => {
    const a = outreachSettings({ settings: {} });
    a.liveChannels.push('sms');
    expect(outreachSettings({ settings: {} }).liveChannels).toEqual(['rep_call']);
  });

  describe('AI call pacing settings', () => {
    it('defaults to 2 live calls, 50 a day and 3 attempts', () => {
      const s = outreachSettings({ settings: {} });
      expect([s.aiCallConcurrency, s.aiCallDailyCap, s.aiCallMaxAttempts]).toEqual([2, 50, 3]);
      expect([DEFAULT_AI_CALL_CONCURRENCY, DEFAULT_AI_CALL_DAILY_CAP, DEFAULT_AI_CALL_MAX_ATTEMPTS]).toEqual([2, 50, 3]);
    });

    it.each([
      ['concurrency 3', { aiCallConcurrency: 3 }, { aiCallConcurrency: 3 }],
      ['concurrency 1 (lowest)', { aiCallConcurrency: 1 }, { aiCallConcurrency: 1 }],
      ['concurrency 5 (highest)', { aiCallConcurrency: 5 }, { aiCallConcurrency: 5 }],
      ['a daily cap of 0 (AI calls off)', { aiCallDailyCap: 0 }, { aiCallDailyCap: 0 }],
      ['a daily cap of 500 (highest)', { aiCallDailyCap: 500 }, { aiCallDailyCap: 500 }],
      ['5 attempts', { aiCallMaxAttempts: 5 }, { aiCallMaxAttempts: 5 }],
      ['1 attempt', { aiCallMaxAttempts: 1 }, { aiCallMaxAttempts: 1 }],
    ])('keeps %s', (_label, settings, expected) => {
      expect(outreachSettings({ settings })).toEqual({ ...DEFAULTS, ...expected });
    });

    it.each([
      ['concurrency 6', { aiCallConcurrency: 6 }],
      ['concurrency 0', { aiCallConcurrency: 0 }],
      ['a daily cap of -1', { aiCallDailyCap: -1 }],
      ['a daily cap of 501', { aiCallDailyCap: 501 }],
      ['attempts 6', { aiCallMaxAttempts: 6 }],
      ['attempts 0', { aiCallMaxAttempts: 0 }],
      ['a fraction', { aiCallConcurrency: 2.5, aiCallDailyCap: 2.5, aiCallMaxAttempts: 2.5 }],
      ['strings', { aiCallConcurrency: '3', aiCallDailyCap: '3', aiCallMaxAttempts: '3' }],
      ['NaN and Infinity', { aiCallConcurrency: Number.NaN, aiCallDailyCap: Number.POSITIVE_INFINITY, aiCallMaxAttempts: null }],
    ])('falls back to the defaults for %s', (_label, settings) => {
      expect(outreachSettings({ settings })).toEqual(DEFAULTS);
    });
  });

  describe('AI call booking and write-back settings (plan 1D)', () => {
    it('DEFAULT_AI_CALL_BOOKING is the plan\'s defaults and parses with the contract', () => {
      expect(DEFAULT_AI_CALL_BOOKING).toEqual(DEFAULTS.aiCallBooking);
      expect(AiCallBookingSettings.safeParse(DEFAULT_AI_CALL_BOOKING).success).toBe(true);
    });

    it('an empty blob gives the defaults: booking on with nobody to book with, write-back on', () => {
      const s = outreachSettings({ settings: {} });
      expect(s.aiCallBooking).toEqual(DEFAULTS.aiCallBooking);
      expect(s.aiCallWriteback).toBe(true);
    });

    it.each([
      ['a non-boolean switch', { enabled: 'yes' }],
      ['a partial blob', { enabled: false }],
      ['a bad user id', { ...DEFAULTS.aiCallBooking, specialists: ['abc'] }],
      ['an end hour before the start hour', { ...DEFAULTS.aiCallBooking, phone: { ...DEFAULTS.aiCallBooking.phone, startHour: 12, endHour: 11 } }],
      ['an unknown key', { ...DEFAULTS.aiCallBooking, rotate: true }],
      ['a string', 'on'],
      ['null', null],
    ])('%s falls back to the default as a whole (never half-applied)', (_label, aiCallBooking) => {
      expect(outreachSettings({ settings: { aiCallBooking } }).aiCallBooking).toEqual(DEFAULTS.aiCallBooking);
    });

    it('the malformed fallback still takes the configured default list', () => {
      const s = outreachSettings({ settings: { aiCallBooking: { enabled: 'yes' } } }, { defaultSpecialists: [GRANT] });
      expect(s.aiCallBooking.specialists).toEqual([GRANT]);
    });

    it('the configured default list is used when the tenant never saved one', () => {
      const s = outreachSettings({ settings: {} }, { defaultSpecialists: [GRANT] });
      expect(s.aiCallBooking).toEqual({ ...DEFAULTS.aiCallBooking, specialists: [GRANT] });
    });

    it('a saved list always wins over the configured default, even an empty one', () => {
      const saved = { ...DEFAULTS.aiCallBooking, specialists: [] };
      expect(outreachSettings({ settings: { aiCallBooking: saved } }, { defaultSpecialists: [GRANT] }).aiCallBooking.specialists).toEqual([]);
      const other = { ...DEFAULTS.aiCallBooking, specialists: [OTHER, GRANT] };
      expect(outreachSettings({ settings: { aiCallBooking: other } }, { defaultSpecialists: [GRANT] }).aiCallBooking.specialists).toEqual([OTHER, GRANT]);
    });

    it('a valid custom blob is kept', () => {
      const custom = {
        enabled: false,
        specialists: [OTHER],
        convertLeads: false,
        days: [1, 3, 5, 6],
        phone: { ...DEFAULTS.aiCallBooking.phone, durationMinutes: 20, stepMinutes: 15, maxOffered: 4 },
        walkthrough: { ...DEFAULTS.aiCallBooking.walkthrough, enabled: false, startHour: 8, endHour: 12 },
      };
      expect(outreachSettings({ settings: { aiCallBooking: custom } }).aiCallBooking).toEqual(custom);
    });

    it('returns fresh objects: changing one result never changes the defaults or the next result', () => {
      const a = outreachSettings({ settings: {} }, { defaultSpecialists: [GRANT] });
      a.aiCallBooking.specialists.push(OTHER);
      a.aiCallBooking.phone.durationMinutes = 99;
      a.aiCallBooking.days.push(6);
      const b = outreachSettings({ settings: {} }, { defaultSpecialists: [GRANT] });
      expect(b.aiCallBooking).toEqual({ ...DEFAULTS.aiCallBooking, specialists: [GRANT] });
      expect(DEFAULT_AI_CALL_BOOKING).toEqual(DEFAULTS.aiCallBooking);
    });

    it.each([
      ['false', false, false],
      ['true', true, true],
      ['the string "false"', 'false', true],
      ['0', 0, true],
      ['null', null, true],
    ])('aiCallWriteback %s gives %s (on unless explicitly false)', (_label, aiCallWriteback, expected) => {
      expect(outreachSettings({ settings: { aiCallWriteback } }).aiCallWriteback).toBe(expected);
    });

    it.each([
      ['on with a specialist', { enabled: true, specialists: [GRANT] }, true],
      ['on with no specialists', { enabled: true, specialists: [] }, false],
      ['off with a specialist', { enabled: false, specialists: [GRANT] }, false],
    ])('bookingActive: %s', (_label, over, expected) => {
      expect(bookingActive({ ...DEFAULTS.aiCallBooking, ...over })).toBe(expected);
    });
  });
});
