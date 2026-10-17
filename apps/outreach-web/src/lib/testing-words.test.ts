import { describe, expect, it } from 'vitest';
import { inboundCall } from '../test/testing-fixtures';
import {
  callDurationWords,
  callerWords,
  formatPhone,
  formatPhoneList,
  inboundBadge,
  inboundDetailRows,
  INBOUND_DETAIL_LABELS,
  phoneName,
  phoneWho,
} from './testing-words';

describe('formatPhone', () => {
  it('writes a US number the way people write it, and leaves anything else as it is', () => {
    expect(formatPhone('+16195550123')).toBe('(619) 555-0123');
    expect(formatPhone('+442071234567')).toBe('+442071234567');
    expect(formatPhone('+1619555012')).toBe('+1619555012');
    expect(formatPhone('client:aitest_x')).toBe('client:aitest_x');
    expect(formatPhone('')).toBe('');
  });
});

describe('formatPhoneList', () => {
  it('joins numbers with "or", for "call this or that"', () => {
    expect(formatPhoneList([])).toBe('');
    expect(formatPhoneList(['+16195550900'])).toBe('(619) 555-0900');
    expect(formatPhoneList(['+16195550900', '+16195550901'])).toBe('(619) 555-0900 or (619) 555-0901');
    expect(formatPhoneList(['+16195550900', '+16195550901', '+16195550902'])).toBe('(619) 555-0900, (619) 555-0901 or (619) 555-0902');
  });
});

describe('phoneName, phoneWho and callerWords', () => {
  it('a listed phone is named by its label, and by its number when it has none', () => {
    expect(phoneName({ e164: '+16195550123', label: 'Grant cell' })).toBe('Grant cell');
    expect(phoneName({ e164: '+16195550123', label: '' })).toBe('(619) 555-0123');
    expect(phoneWho({ e164: '+16195550123', label: 'Grant cell' })).toBe('Grant cell (619) 555-0123');
    expect(phoneWho({ e164: '+16195550123', label: '' })).toBe('(619) 555-0123');
    expect(callerWords({ callerE164: '+16195550123', callerLabel: 'Grant cell' })).toBe('Grant cell');
    expect(callerWords({ callerE164: '+16195550123', callerLabel: '' })).toBe('(619) 555-0123');
    expect(callerWords({ callerE164: '+16195550123', callerLabel: null })).toBe('(619) 555-0123');
  });
});

describe('callDurationWords', () => {
  it('is minutes and seconds, and a dash while the call has no length yet', () => {
    expect(callDurationWords(95)).toBe('1:35');
    expect(callDurationWords(7)).toBe('0:07');
    expect(callDurationWords(600)).toBe('10:00');
    expect(callDurationWords(null)).toBe('—');
  });
});

describe('inboundBadge', () => {
  it.each([
    [{ status: 'completed', outcome: 'qualified' }, 'success', 'Qualified'],
    [{ status: 'completed', outcome: 'callback' }, 'warning', 'Callback'],
    [{ status: 'completed', outcome: 'disqualified' }, 'neutral', 'Disqualified'],
    [{ status: 'completed', outcome: 'incomplete' }, 'outline', 'Incomplete'],
    [{ status: 'completed', outcome: null }, 'outline', 'Incomplete'],
    [{ status: 'in_progress', outcome: null }, 'live', 'In progress'],
    [{ status: 'ringing', outcome: null }, 'live', 'In progress'],
    [{ status: 'failed', outcome: null }, 'danger', 'Failed'],
    [{ status: 'completed', outcome: 'something_new' }, 'neutral', 'Something new'],
  ] as const)('%j reads %s "%s"', (call, tone, words) => {
    expect(inboundBadge(inboundCall(call))).toEqual({ tone, words });
  });

  it('a call that is still live reads in progress whatever was saved so far', () => {
    expect(inboundBadge(inboundCall({ status: 'in_progress', outcome: null, details: { status: 'qualified' } })).words).toBe('In progress');
  });
});

describe('inboundDetailRows', () => {
  it('lists the saved details with their labels, in the order the prompt asks for them, and hides empty ones', () => {
    expect(
      inboundDetailRows({ status: 'callback', notes: 'Wants a quick close', location: '12 Oak St', timeline: '   ', condition: '', price_expectation: '$450k', decision_maker: 'Both owners', urgency: 'High', best_callback_time: 'Evenings' }),
    ).toEqual([
      { label: 'Location', value: '12 Oak St' },
      { label: 'Price expectation', value: '$450k' },
      { label: 'Decision maker', value: 'Both owners' },
      { label: 'Urgency', value: 'High' },
      { label: 'Best callback time', value: 'Evenings' },
      { label: 'Notes', value: 'Wants a quick close' },
    ]);
    expect(inboundDetailRows({ notes: 'n', seller_name: 'Dana', urgency_level: 'high', recommended_next_action: 'call today', walkthrough_time: 'Thursday morning' })).toEqual([
      { label: 'Name', value: 'Dana' },
      { label: 'Walkthrough', value: 'Thursday morning' },
      { label: 'Urgency level', value: 'high' },
      { label: 'Next step', value: 'call today' },
      { label: 'Notes', value: 'n' },
    ]);
    expect(inboundDetailRows({})).toEqual([]);
    expect(inboundDetailRows({ status: 'qualified' })).toEqual([]);
  });

  it('names every field the inbound prompt saves', () => {
    expect(INBOUND_DETAIL_LABELS).toEqual({
      seller_name: 'Name',
      phone_number: 'Best number',
      email: 'Email',
      property_address: 'Property address',
      location: 'Location',
      walkthrough_time: 'Walkthrough',
      timeline: 'Timeline',
      price_expectation: 'Price expectation',
      condition: 'Condition',
      occupancy: 'Who lives there',
      mortgage: 'Owed on it',
      decision_maker: 'Decision maker',
      motivation: 'Why they’re selling',
      urgency: 'Urgency',
      urgency_level: 'Urgency level',
      seller_sentiment: 'How they came across',
      best_callback_time: 'Best callback time',
      recommended_next_action: 'Next step',
      notes: 'Notes',
    });
  });
});
