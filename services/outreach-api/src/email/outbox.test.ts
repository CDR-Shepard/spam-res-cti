import { describe, expect, it } from 'vitest';
import { EMAIL_WINDOW, withinRecipientWindow } from '@cti/firewall';
import { EMAIL_DAILY_CAP, emailSendAt } from './outbox.js';

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
