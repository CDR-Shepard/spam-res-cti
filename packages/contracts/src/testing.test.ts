import { describe, expect, it } from 'vitest';
import {
  AddTestPhoneRequest,
  INBOUND_DETAIL_FIELDS,
  INBOUND_STATUSES,
  INBOUND_TEST_CALLS_SHOWN,
  InboundCallDetails,
  InboundTestCall,
  InboundTestCallsResponse,
  TESTING_INBOUND_CALLS_PATH,
  TESTING_PHONES_PATH,
  TEST_PHONES_MAX,
  TestPhone,
  TestPhonesResponse,
} from './testing.js';
import * as contracts from './index.js';

const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const AT = '2026-10-16T12:00:00.000Z';
const phone = { id: ID, e164: '+16195550123', label: 'Owner cell', addedByEmail: 'admin@example.com', createdAt: AT };
const call = {
  id: ID,
  callerE164: '+16195550123',
  callerLabel: 'Owner cell',
  aiNumber: '+16195550100',
  status: 'completed',
  outcome: 'qualified',
  startedAt: AT,
  durationSeconds: 95,
  details: { status: 'qualified', location: '123 Main St', notes: 'Wants to close fast.' },
};

describe('limits and paths', () => {
  it('allows 25 test phones per org and shows the newest 20 inbound test calls', () => {
    expect(TEST_PHONES_MAX).toBe(25);
    expect(INBOUND_TEST_CALLS_SHOWN).toBe(20);
  });

  it('the routes live under /api/testing', () => {
    expect(TESTING_PHONES_PATH).toBe('/api/testing/phones');
    expect(TESTING_INBOUND_CALLS_PATH).toBe('/api/testing/inbound-calls');
  });
});

describe('TestPhone and TestPhonesResponse', () => {
  it('accepts a phone, one whose adder is gone (null email), and a list', () => {
    expect(TestPhone.parse(phone)).toEqual(phone);
    expect(TestPhone.safeParse({ ...phone, addedByEmail: null }).success).toBe(true);
    expect(TestPhonesResponse.parse({ phones: [phone] })).toEqual({ phones: [phone] });
    expect(TestPhonesResponse.parse({ phones: [] })).toEqual({ phones: [] });
  });

  it('rejects a bad id and a missing label', () => {
    expect(TestPhone.safeParse({ ...phone, id: 'nope' }).success).toBe(false);
    const { label: _label, ...withoutLabel } = phone;
    expect(TestPhone.safeParse(withoutLabel).success).toBe(false);
  });
});

describe('AddTestPhoneRequest', () => {
  it('trims the phone and the label, and the label defaults to an empty string', () => {
    expect(AddTestPhoneRequest.parse({ phone: '  (619) 555-0123 ' })).toEqual({ phone: '(619) 555-0123', label: '' });
    expect(AddTestPhoneRequest.parse({ phone: '+16195550123', label: '  Owner cell ' })).toEqual({
      phone: '+16195550123',
      label: 'Owner cell',
    });
  });

  it('refuses an empty or blank phone, a phone over 40 characters and a label over 60', () => {
    expect(AddTestPhoneRequest.safeParse({ phone: '' }).success).toBe(false);
    expect(AddTestPhoneRequest.safeParse({ phone: '   ' }).success).toBe(false);
    expect(AddTestPhoneRequest.safeParse({ phone: '1'.repeat(41) }).success).toBe(false);
    expect(AddTestPhoneRequest.safeParse({ phone: '1'.repeat(40) }).success).toBe(true);
    expect(AddTestPhoneRequest.safeParse({ phone: '+16195550123', label: 'x'.repeat(61) }).success).toBe(false);
    expect(AddTestPhoneRequest.safeParse({ phone: '+16195550123', label: 'x'.repeat(60) }).success).toBe(true);
  });

  it('is strict: an extra field (an org id, an e164) is refused', () => {
    expect(AddTestPhoneRequest.safeParse({ phone: '+16195550123', orgId: ID }).success).toBe(false);
    expect(AddTestPhoneRequest.safeParse({ phone: '+16195550123', e164: '+16195550123' }).success).toBe(false);
  });

  it('needs a phone', () => {
    expect(AddTestPhoneRequest.safeParse({}).success).toBe(false);
    expect(AddTestPhoneRequest.safeParse({ label: 'Owner cell' }).success).toBe(false);
  });
});

describe('INBOUND_STATUSES and INBOUND_DETAIL_FIELDS', () => {
  it('are the four statuses and the eight detail fields the inbound prompt asks the agent to save', () => {
    expect(INBOUND_STATUSES).toEqual(['qualified', 'callback', 'disqualified', 'incomplete']);
    expect(INBOUND_DETAIL_FIELDS).toEqual([
      'location',
      'timeline',
      'price_expectation',
      'condition',
      'decision_maker',
      'urgency',
      'best_callback_time',
      'notes',
    ]);
  });
});

describe('InboundCallDetails', () => {
  it('accepts an empty object, a full one, and only some fields', () => {
    expect(InboundCallDetails.parse({})).toEqual({});
    const full = {
      status: 'callback',
      location: 'a',
      timeline: 'b',
      price_expectation: 'c',
      condition: 'd',
      decision_maker: 'e',
      urgency: 'f',
      best_callback_time: 'g',
      notes: 'h',
    };
    expect(InboundCallDetails.parse(full)).toEqual(full);
    expect(InboundCallDetails.parse({ notes: 'Wants cash.' })).toEqual({ notes: 'Wants cash.' });
  });

  it.each(INBOUND_STATUSES.map((s) => [s]))('accepts status %s', (status) => {
    expect(InboundCallDetails.safeParse({ status }).success).toBe(true);
  });

  it('refuses an unknown status and a non-string field', () => {
    expect(InboundCallDetails.safeParse({ status: 'maybe' }).success).toBe(false);
    expect(InboundCallDetails.safeParse({ location: 1 }).success).toBe(false);
  });

  it('is not strict: a row saved with an older key still reads (the key is dropped)', () => {
    expect(InboundCallDetails.parse({ notes: 'x', legacy_field: 'y' })).toEqual({ notes: 'x' });
  });
});

describe('InboundTestCall and InboundTestCallsResponse', () => {
  it('accepts a finished call and a still-ringing one with nothing known yet', () => {
    expect(InboundTestCall.parse(call)).toEqual(call);
    const early = { ...call, callerLabel: null, aiNumber: null, outcome: null, durationSeconds: null, details: {} };
    expect(InboundTestCall.parse(early)).toEqual(early);
  });

  it('rejects a fractional duration and a bad id', () => {
    expect(InboundTestCall.safeParse({ ...call, durationSeconds: 1.5 }).success).toBe(false);
    expect(InboundTestCall.safeParse({ ...call, id: 'nope' }).success).toBe(false);
  });

  it('the response carries the AI numbers a tester can dial and the calls', () => {
    const response = { aiNumbers: ['+16195550100'], calls: [call] };
    expect(InboundTestCallsResponse.parse(response)).toEqual(response);
    expect(InboundTestCallsResponse.parse({ aiNumbers: [], calls: [] })).toEqual({ aiNumbers: [], calls: [] });
    expect(InboundTestCallsResponse.safeParse({ calls: [] }).success).toBe(false);
  });
});

describe('contracts index', () => {
  it('exports the testing contracts', () => {
    expect(contracts.TEST_PHONES_MAX).toBe(TEST_PHONES_MAX);
    expect(contracts.AddTestPhoneRequest).toBe(AddTestPhoneRequest);
    expect(contracts.TESTING_PHONES_PATH).toBe(TESTING_PHONES_PATH);
    expect(contracts.InboundTestCallsResponse).toBe(InboundTestCallsResponse);
  });
});
