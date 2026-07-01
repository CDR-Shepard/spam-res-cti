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

describe('buildTaskDescription — lean, Chatter-safe', () => {
  it('contains only rep notes + call time, no CTI diagnostics', () => {
    const d = buildTaskDescription(call());
    expect(d).toContain('STVM then NA');
    expect(d).toMatch(/Call: .*PT/);
    expect(d).not.toContain('Caller Reputation CTI');
    expect(d).not.toContain('Provider');
    expect(d).not.toContain('Reasons');
    expect(d).not.toContain('External_Call_Id__c');
  });

  it('omits the notes line when there are none', () => {
    const d = buildTaskDescription(call({ notes: null }));
    expect(d).not.toContain('STVM');
    expect(d).toMatch(/^Call: /);
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
