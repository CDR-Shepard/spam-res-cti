import { describe, expect, it } from 'vitest';
import {
  buildForwardDialTwiml,
  DEFAULT_INBOUND_RING_SECONDS,
  FORWARD_RING_SECONDS,
  inboundRingSeconds,
  NO_ANSWER_FORWARD_SECONDS,
  resolveForwardTarget,
} from './inbound-forward.js';

describe('resolveForwardTarget', () => {
  it('prefers the per-DID override over the rep failover number', () => {
    expect(
      resolveForwardTarget({ numberForwardE164: '+16195550001', repForwardE164: '+13105550002' }),
    ).toBe('+16195550001');
  });

  it('falls back to the rep failover number when there is no per-DID override', () => {
    expect(
      resolveForwardTarget({ numberForwardE164: null, repForwardE164: '+13105550002' }),
    ).toBe('+13105550002');
  });

  it('returns null when neither is set', () => {
    expect(resolveForwardTarget({ numberForwardE164: null, repForwardE164: null })).toBeNull();
    expect(resolveForwardTarget({})).toBeNull();
  });

  it('treats empty / whitespace-only values as unset', () => {
    expect(resolveForwardTarget({ numberForwardE164: '   ', repForwardE164: '+13105550002' })).toBe(
      '+13105550002',
    );
    expect(resolveForwardTarget({ numberForwardE164: '', repForwardE164: '  ' })).toBeNull();
  });
});

describe('inboundRingSeconds', () => {
  it('rings the short (10s) window when a failover number exists', () => {
    expect(inboundRingSeconds(true)).toBe(NO_ANSWER_FORWARD_SECONDS);
    expect(NO_ANSWER_FORWARD_SECONDS).toBe(10);
  });

  it('rings the full default window when there is no failover', () => {
    expect(inboundRingSeconds(false)).toBe(DEFAULT_INBOUND_RING_SECONDS);
  });
});

describe('buildForwardDialTwiml', () => {
  const base = {
    apiPublicUrl: 'https://api.example.com',
    callDbId: '11111111-1111-1111-1111-111111111111',
    forwardE164: '+13105550002',
    callerIdE164: '+16195550100',
    record: false,
  };

  it('dials the failover number, showing the called DID as caller ID', () => {
    const xml = buildForwardDialTwiml(base);
    expect(xml).toContain('<Number>+13105550002</Number>');
    expect(xml).toContain('callerId="+16195550100"');
    expect(xml).toContain(`timeout="${FORWARD_RING_SECONDS}"`);
  });

  it('points the action at dial-result with the leg=forward loop guard', () => {
    const xml = buildForwardDialTwiml(base);
    expect(xml).toContain('/telephony/twilio/inbound/dial-result');
    expect(xml).toContain(`callDbId=${base.callDbId}`);
    expect(xml).toContain('leg=forward');
  });

  it('omits recording attributes when record is false', () => {
    const xml = buildForwardDialTwiml(base);
    expect(xml).not.toContain('record-from-answer-dual');
    expect(xml).not.toContain('/telephony/twilio/recording');
  });

  it('includes the dual-channel recording + status callback when record is true', () => {
    const xml = buildForwardDialTwiml({ ...base, record: true });
    expect(xml).toContain('record="record-from-answer-dual"');
    expect(xml).toContain('/telephony/twilio/recording?callDbId=');
  });
});
