import { describe, expect, it } from 'vitest';
import { buildCallSubject, formatNanp } from './call-subject';

describe('formatNanp', () => {
  it('renders NANP as (XXX) XXX-XXXX and passes anything else through', () => {
    expect(formatNanp('+16195551234')).toBe('(619) 555-1234');
    expect(formatNanp('+442071234567')).toBe('+442071234567');
    expect(formatNanp('anonymous')).toBe('anonymous');
  });
});

describe('buildCallSubject', () => {
  it('outbound with disposition and name', () => {
    expect(buildCallSubject({ inbound: false, disposition: 'Voicemail', counterpartyE164: '+16195551234', recordName: 'Jane Doe' }))
      .toBe('Outbound Call | Voicemail | (619) 555-1234 / Jane Doe');
  });
  it('inbound, no record matched — no dangling slash (a real disposition still shows)', () => {
    expect(buildCallSubject({ inbound: true, disposition: 'Connected', counterpartyE164: '+16195551234' }))
      .toBe('Inbound Call | Connected | (619) 555-1234');
  });
  it('inbound with NO disposition omits the middle slot entirely', () => {
    // Inbound calls never get a disposition anywhere in the system (no wrap-up
    // form, and the sweep is outbound-scoped), so the auto-disposition fallback
    // would fire on 100% of them and read as a system-wide failure to
    // disposition. Outbound keeps the fallback; inbound drops the slot.
    expect(buildCallSubject({ inbound: true, disposition: null, counterpartyE164: '+16195551234', recordName: 'Jane Doe' }))
      .toBe('Inbound Call | (619) 555-1234 / Jane Doe');
    expect(buildCallSubject({ inbound: true, disposition: '   ', counterpartyE164: '+16195551234' }))
      .toBe('Inbound Call | (619) 555-1234');
  });
  it('null/empty disposition renders as the auto-disposition', () => {
    expect(buildCallSubject({ inbound: false, disposition: null, counterpartyE164: '+16195551234', recordName: null }))
      .toBe('Outbound Call | Not dispositioned | (619) 555-1234');
    expect(buildCallSubject({ inbound: false, disposition: '', counterpartyE164: '+16195551234' }))
      .toBe('Outbound Call | Not dispositioned | (619) 555-1234');
  });
  it('whitespace-only names are treated as absent', () => {
    expect(buildCallSubject({ inbound: false, disposition: 'Voicemail', counterpartyE164: '+16195551234', recordName: '  ' }))
      .toBe('Outbound Call | Voicemail | (619) 555-1234');
  });
});
