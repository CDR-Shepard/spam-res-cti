import type { InboundTestCall, InboundTestCallsResponse, TestPhone, TestPhonesResponse } from '@cti/contracts';

export const PHONE_A = '11111111-1111-4111-8111-aaaaaaaaaaaa';
export const PHONE_B = '22222222-2222-4222-8222-bbbbbbbbbbbb';
export const CALL_A = '33333333-3333-4333-8333-aaaaaaaaaaaa';
export const CALL_B = '44444444-4444-4444-8444-bbbbbbbbbbbb';
export const ADDED_AT = '2026-10-16T19:42:00.000Z';
export const CALLED_AT = '2026-10-16T20:15:00.000Z';

export function testPhone(over: Partial<TestPhone> = {}): TestPhone {
  return { id: PHONE_A, e164: '+16195550123', label: 'Grant cell', addedByEmail: 'grant@gghomes.com', createdAt: ADDED_AT, ...over };
}

export const phonesResponse = (...phones: TestPhone[]): TestPhonesResponse => ({ phones });

export function inboundCall(over: Partial<InboundTestCall> = {}): InboundTestCall {
  return {
    id: CALL_A,
    callerE164: '+16195550123',
    callerLabel: 'Grant cell',
    aiNumber: '+16195550900',
    status: 'completed',
    outcome: 'qualified',
    startedAt: CALLED_AT,
    durationSeconds: 95,
    details: {},
    ...over,
  };
}

export function inboundResponse(over: Partial<InboundTestCallsResponse> = {}): InboundTestCallsResponse {
  return { aiNumbers: ['+16195550900'], calls: [], ...over };
}
