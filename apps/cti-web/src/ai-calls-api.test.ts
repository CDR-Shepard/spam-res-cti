import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import {
  aiCallErrorMessage,
  aiCallTargetFor,
  aiTransferLabel,
  BLOCK_WORDS,
  getAiAvailability,
  isLiveRow,
  listAiCalls,
  outcomeWords,
  RATE_LIMIT_WORDS,
  startAiCall,
  statusWords,
} from './ai-calls-api';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('aiCallTargetFor', () => {
  it('takes the object type Salesforce sent, for Lead / Opportunity / Contact', () => {
    expect(aiCallTargetFor({ recordId: '00Q5e00000AbCdEFGH', objectType: 'Lead' })).toEqual({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' });
    expect(aiCallTargetFor({ recordId: '0065e00000AbCdE', objectType: 'opportunity' })).toEqual({ objectType: 'Opportunity', recordId: '0065e00000AbCdE' });
    expect(aiCallTargetFor({ recordId: '0035e00000AbCdE', objectType: 'Contact' })).toEqual({ objectType: 'Contact', recordId: '0035e00000AbCdE' });
  });

  it('with no object type, derives it from the id prefix', () => {
    expect(aiCallTargetFor({ recordId: '00Q5e00000AbCdE' })?.objectType).toBe('Lead');
    expect(aiCallTargetFor({ recordId: '0065e00000AbCdE' })?.objectType).toBe('Opportunity');
    expect(aiCallTargetFor({ recordId: '0035e00000AbCdE' })?.objectType).toBe('Contact');
  });

  it('anything else gets no AI call', () => {
    expect(aiCallTargetFor(null)).toBeNull();
    expect(aiCallTargetFor({})).toBeNull();
    expect(aiCallTargetFor({ recordId: '0015e00000AbCdE' })).toBeNull(); // Account
    expect(aiCallTargetFor({ recordId: '0015e00000AbCdE', objectType: 'Account' })).toBeNull();
    expect(aiCallTargetFor({ recordId: '00Q5e00000AbCdE', objectType: 'Account' })).toBeNull(); // SF's word wins
    expect(aiCallTargetFor({ recordId: '00Q-bad' })).toBeNull();
  });
});

describe('API calls', () => {
  it('POST /ai-calls sends the record as JSON', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ aiCallId: 'ai-1', status: 'ringing' }, 201));
    vi.stubGlobal('fetch', fetchMock);
    await expect(startAiCall({ objectType: 'Lead', recordId: '00Q5e00000AbCdE' })).resolves.toEqual({ aiCallId: 'ai-1', status: 'ringing' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; body: string }];
    expect(url).toMatch(/\/ai-calls$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ objectType: 'Lead', recordId: '00Q5e00000AbCdE' });
  });

  it('availability reads anything but true as off', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
    await expect(getAiAvailability()).resolves.toEqual({ available: false, testNumbers: [] });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ available: true, testNumbers: ['+16195550100'] })));
    await expect(getAiAvailability()).resolves.toEqual({ available: true, testNumbers: ['+16195550100'] });
  });

  it('the list asks for 20 and unwraps aiCalls', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ aiCalls: [{ id: 'a' }] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listAiCalls()).resolves.toEqual([{ id: 'a' }]);
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toMatch(/\/ai-calls\?limit=20$/);
  });
});

describe('words', () => {
  it('every 409 block reason has plain words', () => {
    const reasons = ['ai_voice_unavailable', 'no_consent', 'consent_field_missing', 'no_phone', 'opted_out', 'blocked', 'dnc',
      'daily_cap', 'customer_ceiling', 'calling_hours', 'no_caller_id', 'not_admin_for_test', 'invalid_number', 'call_in_progress'];
    for (const r of reasons) expect(BLOCK_WORDS[r], r).toBeTruthy();
    expect(aiCallErrorMessage(new ApiError(409, { error: 'no_consent', aiCallId: 'x' })))
      .toBe("This record hasn't agreed to AI calls — AI Call Consent is unticked in Salesforce.");
    expect(aiCallErrorMessage(new ApiError(409, { error: 'calling_hours' }))).toMatch(/outside calling hours/);
  });

  it('HTTP errors read plainly', () => {
    expect(aiCallErrorMessage(new ApiError(429, { error: 'Too Many Requests' }))).toBe(RATE_LIMIT_WORDS);
    expect(aiCallErrorMessage(new ApiError(404, { error: 'record_not_found' }))).toMatch(/couldn't find this record/);
    expect(aiCallErrorMessage(new ApiError(502, { error: 'salesforce_error' }))).toMatch(/Salesforce/);
    expect(aiCallErrorMessage(new ApiError(502, { error: 'twilio_error', aiCallId: 'x' }))).toMatch(/phone system/);
    expect(aiCallErrorMessage(new ApiError(503, { error: 'gate_error' }))).toMatch(/safety checks/);
    expect(aiCallErrorMessage(new Error('network'))).toBe("Couldn't start the AI call.");
  });

  it('statuses and outcomes', () => {
    expect(statusWords('ringing')).toBe('Calling…');
    expect(statusWords('in_progress')).toBe('In progress');
    expect(outcomeWords('transfer_failed')).toBe('Transfer missed — callback promised');
    expect(outcomeWords(null)).toBe('');
  });

  it('AI transfer label', () => {
    expect(aiTransferLabel('wants_offer')).toBe('AI transfer — wants an offer');
    expect(aiTransferLabel(undefined)).toBeUndefined();
  });
});

describe('isLiveRow', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  it('a running call is live; an ended one only for a short grace', () => {
    expect(isLiveRow({ status: 'in_progress', endedAt: null }, now)).toBe(true);
    expect(isLiveRow({ status: 'completed', endedAt: '2026-10-05T11:59:55Z' }, now)).toBe(true);
    expect(isLiveRow({ status: 'completed', endedAt: '2026-10-05T11:50:00Z' }, now)).toBe(false);
    expect(isLiveRow({ status: 'failed', endedAt: null }, now)).toBe(false);
  });
});
