import { describe, expect, it } from 'vitest';
import { buildFullDetail, buildTaskDescription } from './sync.js';

type CallRow = Parameters<typeof buildFullDetail>[0];
type AuditRow = NonNullable<Parameters<typeof buildFullDetail>[1]>;

const call = (over: Partial<CallRow> = {}): CallRow => ({
  notes: 'STVM then NA',
  normalizedToNumber: '+18184455992',
  fromNumber: '+13235249247',
  provider: 'twilio',
  providerCallId: 'CA0786cee5011196eb88884e592ffeb2c6',
  durationSeconds: 4,
  disposition: 'No answer',
  startedAt: new Date('2026-07-01T21:37:58Z'),
  endedAt: new Date('2026-07-01T21:37:58Z'),
  ...over,
} as unknown as CallRow);

const audit = (over: Partial<AuditRow> = {}): AuditRow => ({
  decision: 'ALLOW',
  blockReason: null,
  reasons: ['PHONE_PARSED', 'FEDERAL_DNC_PRESCRUBBED'],
  ...over,
} as unknown as AuditRow);

const customFields = {
  External_Call_Id__c: 'call-1',
  From_Number__c: '+13235249247',
  To_Number__c: '818-445-5992',
};

describe('buildTaskDescription — rep notes only (Chatter-safe)', () => {
  it('is exactly the rep notes, no diagnostics or call-time line', () => {
    const d = buildTaskDescription(call());
    expect(d).toBe('STVM then NA');
    expect(d).not.toContain('Call:');
    expect(d).not.toContain('Caller Reputation CTI');
    expect(d).not.toContain('External_Call_Id__c');
  });

  it('is EMPTY when there are no notes (so the Chatter flow skips the call)', () => {
    expect(buildTaskDescription(call({ notes: null }))).toBe('');
    expect(buildTaskDescription(call({ notes: '   ' }))).toBe('');
  });
});

describe('buildFullDetail — complete record for our DB', () => {
  it('captures notes, the CTI block, reasons, and extended metadata', () => {
    const d = buildFullDetail(call(), audit(), customFields);
    expect(d).toContain('STVM then NA');
    expect(d).toContain('--- Caller Reputation CTI ---');
    expect(d).toContain('From: +13235249247');
    expect(d).toContain('FEDERAL_DNC_PRESCRUBBED');
    expect(d).toContain('--- Extended metadata ---');
    expect(d).toContain('External_Call_Id__c: call-1');
  });
});
