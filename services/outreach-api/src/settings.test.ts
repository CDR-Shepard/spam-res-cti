import { describe, expect, it } from 'vitest';
import {
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
};

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
});
