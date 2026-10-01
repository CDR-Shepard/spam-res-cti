import { describe, expect, it } from 'vitest';
import {
  CONNECT_TASK_DESCRIPTION,
  MAX_TRIES,
  RETRY_DELAYS_MS,
  buildConnectTaskInput,
  leaseFor,
  taskLinks,
} from './dialer-connect-task.js';

const ROW = {
  id: '11111111-2222-4333-8444-555555555555',
  callSid: 'CA' + 'a'.repeat(32),
  fromNumber: '+16195550101',
  toNumber: '+16195559999',
  bridgedAt: new Date('2026-10-01T18:00:00Z'),
  endedAt: new Date('2026-10-01T18:02:05Z'),
  talkSeconds: 125,
};

describe('backoff', () => {
  it('5 min, 15 min, 1 h, 3 h, 6 h — the 6th try is the last', () => {
    expect(RETRY_DELAYS_MS).toEqual([5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 60 * 60_000, 6 * 60 * 60_000]);
    expect(MAX_TRIES).toBe(6);
  });
  it('leaseFor(n) is try n\'s backoff, clamped at both ends; never under 5 min (a row\'s worst case is ~3 min)', () => {
    expect(leaseFor(1)).toBe(5 * 60_000);
    expect(leaseFor(3)).toBe(60 * 60_000);
    expect(leaseFor(6)).toBe(6 * 60 * 60_000);
    expect(leaseFor(99)).toBe(6 * 60 * 60_000);
    expect(leaseFor(0)).toBe(5 * 60_000);
  });
});

describe('taskLinks', () => {
  it('a Lead or a Contact is the WhoId; an Opportunity is the WhatId', () => {
    expect(taskLinks('Lead', '00Q1')).toEqual({ whoId: '00Q1' });
    expect(taskLinks('Contact', '0031')).toEqual({ whoId: '0031' });
    expect(taskLinks('Opportunity', '0061')).toEqual({ whatId: '0061' });
  });
  it('anything else has no link — the worker fails the row rather than log an orphan Task', () => {
    expect(taskLinks('Task', '00T1')).toBeNull();
    expect(taskLinks('Account', '0011')).toBeNull();
  });
});

describe('buildConnectTaskInput', () => {
  it('follows THE call-subject rule and logs a completed outbound "Connected" call with the talk time', () => {
    const input = buildConnectTaskInput(ROW, { whatId: '0061' }, 'Jane Doe');
    expect(input).toEqual({
      subject: 'Outbound Call | Connected | (619) 555-9999 / Jane Doe',
      callType: 'Outbound',
      callDisposition: 'Connected',
      callDurationInSeconds: 125,
      activityDate: '2026-10-01',
      whatId: '0061',
      description: CONNECT_TASK_DESCRIPTION,
      customFields: {
        External_Call_Id__c: ROW.id,
        Provider_Call_Id__c: ROW.callSid,
        From_Number__c: '+16195550101',
        To_Number__c: '+16195559999',
        Normalized_To_Number__c: '+16195559999',
        Call_Start_Time__c: '2026-10-01T18:00:00.000Z',
        Call_End_Time__c: '2026-10-01T18:02:05.000Z',
        CTI_Provider__c: 'twilio',
        Outbound_Caller_ID__c: '+16195550101',
      },
    });
  });
  it('is dated the Pacific day it was BRIDGED — a 6:30 pm PT call is still that day, though UTC has rolled over', () => {
    const late = buildConnectTaskInput({ ...ROW, bridgedAt: new Date('2026-10-02T01:30:00Z') }, { whoId: '00Q1' }, null);
    expect(late.activityDate).toBe('2026-10-01');
  });
  it('no name → number-only subject; no hang-up stamp → no duration, no end time', () => {
    const input = buildConnectTaskInput({ ...ROW, endedAt: null, talkSeconds: null }, { whoId: '00Q1' }, null);
    expect(input.subject).toBe('Outbound Call | Connected | (619) 555-9999');
    expect(input.callDurationInSeconds).toBeUndefined();
    expect(input.customFields?.Call_End_Time__c).toBeNull();
    expect(input.whoId).toBe('00Q1');
    expect(input).not.toHaveProperty('whatId');
  });
});
