import { describe, expect, it } from 'vitest';
import { EMAIL_WINDOW, withinRecipientWindow } from '@cti/firewall';
import { EMAIL_DAILY_CAP, emailSendAt, sellerBlock, switchBlock, type SellerFacts } from './outbox.js';

describe('EMAIL_DAILY_CAP', () => {
  it('is 3 emails a day per conversation', () => {
    expect(EMAIL_DAILY_CAP).toBe(3);
  });
});

describe('emailSendAt', () => {
  const CENTRAL = [{ e164: '+13125550100' }];
  const TEXAS = [{ e164: '+15125550100' }];
  const PACIFIC = [{ e164: '+14155550100' }];

  it('is now when it is already inside the seller\'s 08:00-18:00', () => {
    const noonCentral = new Date('2026-10-20T17:00:00.000Z');
    expect(emailSendAt(CENTRAL, noonCentral)).toEqual(noonCentral);
  });

  it('waits for 08:00 seller-local the next morning when it is evening there', () => {
    // 21:00 CDT on Tuesday Oct 20.
    expect(emailSendAt(CENTRAL, new Date('2026-10-21T02:00:00.000Z'))).toEqual(new Date('2026-10-21T13:00:00.000Z'));
  });

  it('a state\'s own hours narrow the window: Texas opens at 09:00', () => {
    expect(emailSendAt(TEXAS, new Date('2026-10-21T02:00:00.000Z'))).toEqual(new Date('2026-10-21T14:00:00.000Z'));
  });

  it('uses the first phone: the same instant is early morning in Pacific time and waits for 08:00 there', () => {
    // 06:30 PDT: before the window opens at 08:00 PDT (15:00 UTC).
    expect(emailSendAt(PACIFIC, new Date('2026-10-20T13:30:00.000Z'))).toEqual(new Date('2026-10-20T15:00:00.000Z'));
    expect(emailSendAt([...PACIFIC, ...CENTRAL], new Date('2026-10-20T13:30:00.000Z'))).toEqual(new Date('2026-10-20T15:00:00.000Z'));
  });

  it('with no phone at all, uses Central time', () => {
    expect(emailSendAt([], new Date('2026-10-21T02:00:00.000Z'))).toEqual(new Date('2026-10-21T13:00:00.000Z'));
    expect(emailSendAt([], new Date('2026-10-20T17:00:00.000Z'))).toEqual(new Date('2026-10-20T17:00:00.000Z'));
  });

  it('always lands inside the window', () => {
    for (const phones of [CENTRAL, PACIFIC]) {
      const at = emailSendAt(phones, new Date('2026-10-21T02:00:00.000Z'));
      expect(withinRecipientWindow(phones[0]!.e164, at, EMAIL_WINDOW)).toBe(true);
    }
  });
});

describe('switchBlock (rule 1)', () => {
  it('is disabled unless the switch is exactly on, then paused while a pause is set', () => {
    expect(switchBlock({})).toBe('disabled');
    expect(switchBlock({ samEmail: { enabled: 'yes' } })).toBe('disabled');
    expect(switchBlock({ samEmail: { enabled: false, pausedAt: '2026-10-20T12:00:00.000Z' } })).toBe('disabled');
    expect(switchBlock({ samEmail: { enabled: true, pausedAt: '2026-10-20T12:00:00.000Z' } })).toBe('paused');
    expect(switchBlock({ samEmail: { enabled: true } })).toBeNull();
  });
});

describe('sellerBlock (rules 2 to 7, pure)', () => {
  const open: SellerFacts = { purpose: 'first', conversationStatus: 'open', handler: 'sam', flagReason: null, suppressed: false, sfEmailOptOut: false };

  it('is null for an open conversation Sam handles, an unsuppressed address and no Salesforce opt-out', () => {
    expect(sellerBlock(open)).toBeNull();
  });

  it('answers in the order the seller page explains: stopped, booked, taken_over, flagged, suppressed, sf_opt_out', () => {
    const all: SellerFacts = { ...open, conversationStatus: 'stopped', handler: 'person', flagReason: 'unsure', suppressed: true, sfEmailOptOut: true };
    expect(sellerBlock(all)).toBe('stopped');
    expect(sellerBlock({ ...all, conversationStatus: 'booked' })).toBe('booked');
    expect(sellerBlock({ ...all, conversationStatus: 'open' })).toBe('taken_over');
    expect(sellerBlock({ ...all, conversationStatus: 'open', handler: 'sam' })).toBe('flagged');
    expect(sellerBlock({ ...all, conversationStatus: 'open', handler: 'sam', flagReason: null })).toBe('suppressed');
    expect(sellerBlock({ ...open, sfEmailOptOut: true })).toBe('sf_opt_out');
  });

  it('a holding email still goes to a booked seller; a flag holds back only first emails and replies', () => {
    expect(sellerBlock({ ...open, purpose: 'holding', conversationStatus: 'booked' })).toBeNull();
    expect(sellerBlock({ ...open, purpose: 'holding', flagReason: 'wants_appointment' })).toBeNull();
    expect(sellerBlock({ ...open, purpose: 'reply', flagReason: 'wants_appointment' })).toBe('flagged');
  });
});
