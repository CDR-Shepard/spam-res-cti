import { describe, expect, it } from 'vitest';
import { AiCallBookingSettings } from '@cti/contracts';
import {
  bookingActive,
  bookingSettings,
  DEFAULT_AI_CALL_BOOKING,
  DEFAULT_AI_CALL_CONCURRENCY,
  DEFAULT_AI_CALL_DAILY_CAP,
  DEFAULT_AI_CALL_MAX_ATTEMPTS,
  outreachSettings,
  type OutreachSettings,
} from './settings.js';

// Final review WEB I-2: booking and Lead conversion are off until an admin turns them on (after the readiness check, a
// practice call and the one-Lead check), whatever AI_CALL_DEFAULT_SPECIALISTS says.
const DEFAULT_BOOKING: AiCallBookingSettings = {
    enabled: false,
    specialists: [],
    convertLeads: false,
    days: [1, 2, 3, 4, 5],
    phone: { enabled: true, durationMinutes: 15, startHour: 10, endHour: 18, stepMinutes: 30, minLeadMinutes: 120, horizonBusinessDays: 2, bufferMinutes: 0, maxOffered: 6 },
    walkthrough: { enabled: true, durationMinutes: 60, startHour: 9, endHour: 17, stepMinutes: 60, minLeadMinutes: 1200, horizonBusinessDays: 5, bufferMinutes: 30, maxOffered: 6 },
};

const DEFAULTS: OutreachSettings = {
  aiDailyBudgetUsd: 25,
  liveChannels: ['rep_call'],
  consentFromWebForms: false,
  consentFromInboundCalls: false,
  aiCallConcurrency: 2,
  aiCallDailyCap: 50,
  aiCallMaxAttempts: 3,
  aiCallWriteback: false,
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
      expect(DEFAULT_AI_CALL_BOOKING).toEqual(DEFAULT_BOOKING);
      expect(AiCallBookingSettings.safeParse(DEFAULT_AI_CALL_BOOKING).success).toBe(true);
    });

    it('final review WEB I-2: an empty blob gives the defaults: booking, conversion and write-back all off', () => {
      expect(bookingSettings({ settings: {} }, [])).toEqual(DEFAULT_BOOKING);
      expect(outreachSettings({ settings: {} }).aiCallWriteback).toBe(false);
    });

    it('final review WEB I-2: a configured default owner fills the list but turns nothing on', () => {
      const b = bookingSettings({ settings: {} }, [GRANT]);
      expect(b).toMatchObject({ enabled: false, convertLeads: false, specialists: [GRANT] });
      expect(bookingActive(b)).toBe(false);
    });

    it('Fix 1 (M-4): booking is read only through bookingSettings, whose default list is required', () => {
      expect('aiCallBooking' in outreachSettings({ settings: { aiCallBooking: DEFAULT_BOOKING } })).toBe(false);
      // Type-level: a reader cannot forget the configured default list (never called).
      const forgot = () => {
        // @ts-expect-error defaultSpecialists is required
        bookingSettings({ settings: {} });
      };
      expect(forgot).toBeTypeOf('function');
    });

    it.each([
      ['a non-boolean switch', { enabled: 'yes' }],
      ['a partial blob', { enabled: false }],
      ['a bad user id', { ...DEFAULT_BOOKING, specialists: ['abc'] }],
      ['an end hour before the start hour', { ...DEFAULT_BOOKING, phone: { ...DEFAULT_BOOKING.phone, startHour: 12, endHour: 11 } }],
      ['an unknown key', { ...DEFAULT_BOOKING, rotate: true }],
      ['a string', 'on'],
      ['null', null],
    ])('%s falls back to the default as a whole (never half-applied)', (_label, aiCallBooking) => {
      expect(bookingSettings({ settings: { aiCallBooking } }, [])).toEqual(DEFAULT_BOOKING);
    });

    it('the malformed fallback still takes the configured default list', () => {
      expect(bookingSettings({ settings: { aiCallBooking: { enabled: 'yes' } } }, [GRANT]).specialists).toEqual([GRANT]);
    });

    it('the configured default list is used when the tenant never saved one', () => {
      expect(bookingSettings({ settings: {} }, [GRANT])).toEqual({ ...DEFAULT_BOOKING, specialists: [GRANT] });
    });

    it('a saved list always wins over the configured default, even an empty one', () => {
      const saved = { ...DEFAULT_BOOKING, specialists: [] };
      expect(bookingSettings({ settings: { aiCallBooking: saved } }, [GRANT]).specialists).toEqual([]);
      const other = { ...DEFAULT_BOOKING, specialists: [OTHER, GRANT] };
      expect(bookingSettings({ settings: { aiCallBooking: other } }, [GRANT]).specialists).toEqual([OTHER, GRANT]);
    });

    it('a valid custom blob is kept', () => {
      const custom = {
        enabled: false,
        specialists: [OTHER],
        convertLeads: false,
        days: [1, 3, 5, 6],
        phone: { ...DEFAULT_BOOKING.phone, durationMinutes: 20, stepMinutes: 15, maxOffered: 4 },
        walkthrough: { ...DEFAULT_BOOKING.walkthrough, enabled: false, startHour: 8, endHour: 12 },
      };
      expect(bookingSettings({ settings: { aiCallBooking: custom } }, [GRANT])).toEqual(custom);
    });

    it('returns fresh objects: changing one result never changes the defaults or the next result', () => {
      const a = bookingSettings({ settings: {} }, [GRANT]);
      a.specialists.push(OTHER);
      a.phone.durationMinutes = 99;
      a.days.push(6);
      const b = bookingSettings({ settings: {} }, [GRANT]);
      expect(b).toEqual({ ...DEFAULT_BOOKING, specialists: [GRANT] });
      expect(DEFAULT_AI_CALL_BOOKING).toEqual(DEFAULT_BOOKING);
    });

    it.each([
      ['false', false, false],
      ['true', true, true],
      ['the string "true"', 'true', false],
      ['1', 1, false],
      ['null', null, false],
      ['absent', undefined, false],
    ])('aiCallWriteback %s gives %s (off unless explicitly true, final review WEB I-2)', (_label, aiCallWriteback, expected) => {
      expect(outreachSettings({ settings: { aiCallWriteback } }).aiCallWriteback).toBe(expected);
    });

    it.each([
      ['on with a specialist', { enabled: true, specialists: [GRANT] }, true],
      ['on with no specialists', { enabled: true, specialists: [] }, false],
      ['off with a specialist', { enabled: false, specialists: [GRANT] }, false],
    ])('bookingActive: %s', (_label, over, expected) => {
      expect(bookingActive({ ...DEFAULT_BOOKING, ...over })).toBe(expected);
    });
  });
});
