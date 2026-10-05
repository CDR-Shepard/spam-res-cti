import { describe, expect, it } from 'vitest';
import { outreachSettings, type OutreachSettings } from './settings.js';

const DEFAULTS: OutreachSettings = { aiDailyBudgetUsd: 25, liveChannels: ['rep_call'], consentFromWebForms: false, consentFromInboundCalls: false };

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
    expect(outreachSettings({ settings })).toEqual({ aiDailyBudgetUsd: 40.5, liveChannels: ['rep_call'], consentFromWebForms: true, consentFromInboundCalls: true });
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
});
