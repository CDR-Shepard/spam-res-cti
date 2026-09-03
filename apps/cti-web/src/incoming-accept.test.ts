import { describe, expect, it, vi } from 'vitest';
import { acceptIncomingCall, getIncomingCallerInfo, planIncomingAccept } from './incoming-accept';

describe('getIncomingCallerInfo', () => {
  it('reads the caller number from the standard Twilio `From` parameter', () => {
    const info = getIncomingCallerInfo({ parameters: { From: '+16195551234' } });
    expect(info.from).toBe('+16195551234');
  });

  it('falls back to lowercase `from` when `From` is absent (defensive)', () => {
    const info = getIncomingCallerInfo({ parameters: { from: '+16195551234' } });
    expect(info.from).toBe('+16195551234');
  });

  it('is an empty string when there are no parameters at all', () => {
    expect(getIncomingCallerInfo({}).from).toBe('');
  });

  it('reads callerName/recordId/recordType off customParameters when the caller matched a Salesforce record', () => {
    const info = getIncomingCallerInfo({
      parameters: { From: '+16195551234' },
      customParameters: new Map([
        ['callerName', 'Jane Doe'],
        ['recordId', '00Q000000000001AAA'],
        ['recordType', 'Lead'],
      ]),
    });
    expect(info.callerName).toBe('Jane Doe');
    expect(info.recordId).toBe('00Q000000000001AAA');
    expect(info.recordType).toBe('Lead');
  });

  it('leaves callerName/recordId/recordType undefined for an unmatched caller (no customParameters)', () => {
    const info = getIncomingCallerInfo({ parameters: { From: '+16195551234' } });
    expect(info.callerName).toBeUndefined();
    expect(info.recordId).toBeUndefined();
    expect(info.recordType).toBeUndefined();
  });
});

describe('planIncomingAccept', () => {
  it('carries the real Salesforce name + record into active-call state, and targets it for screen-pop', () => {
    const plan = planIncomingAccept({
      parameters: { From: '+16195551234' },
      customParameters: new Map([
        ['callerName', 'Jane Doe'],
        ['recordId', '00Q000000000001AAA'],
        ['recordType', 'Lead'],
      ]),
    });
    expect(plan.activeCall).toEqual({
      toNumber: '+16195551234',
      fromNumber: '+16195551234',
      recordName: 'Jane Doe',
      recordId: '00Q000000000001AAA',
      objectType: 'Lead',
    });
    expect(plan.screenPopRecordId).toBe('00Q000000000001AAA');
  });

  it('falls back to the literal "Incoming call" label and skips screen-pop for an unmatched caller', () => {
    const plan = planIncomingAccept({ parameters: { From: '+16195551234' } });
    expect(plan.activeCall).toEqual({
      toNumber: '+16195551234',
      fromNumber: '+16195551234',
      recordName: 'Incoming call',
      recordId: undefined,
      objectType: undefined,
    });
    expect(plan.screenPopRecordId).toBeUndefined();
  });

  it('does not target a screen-pop for a whatId-only Deal match with no name (defensive parity with the server)', () => {
    const plan = planIncomingAccept({
      parameters: { From: '+16195551234' },
      customParameters: new Map([
        ['recordId', 'a0X000000000009AAA'],
        ['recordType', 'Record'],
      ]),
    });
    expect(plan.activeCall.recordName).toBe('Incoming call');
    expect(plan.activeCall.recordId).toBe('a0X000000000009AAA');
    expect(plan.screenPopRecordId).toBe('a0X000000000009AAA');
  });

  it('uses the real name but skips screen-pop for a matched caller with neither id (name-only match, mirrors the server\'s "Ghost" case)', () => {
    const plan = planIncomingAccept({
      parameters: { From: '+16195551234' },
      customParameters: new Map([['callerName', 'Ghost']]),
    });
    expect(plan.activeCall.recordName).toBe('Ghost');
    expect(plan.activeCall.recordId).toBeUndefined();
    expect(plan.screenPopRecordId).toBeUndefined();
  });
});

describe('acceptIncomingCall', () => {
  it('screen-pops exactly once with the matched recordId', () => {
    const screenPop = vi.fn();
    const call = {
      parameters: { From: '+16195551234' },
      customParameters: new Map([
        ['callerName', 'Jane Doe'],
        ['recordId', '00Q000000000001AAA'],
        ['recordType', 'Lead'],
      ]),
    };

    const plan = acceptIncomingCall(call, { screenPop });

    expect(screenPop).toHaveBeenCalledTimes(1);
    expect(screenPop).toHaveBeenCalledWith('00Q000000000001AAA');
    expect(plan.activeCall.recordName).toBe('Jane Doe');
  });

  it('never screen-pops for an unmatched caller (no recordId)', () => {
    const screenPop = vi.fn();
    const call = { parameters: { From: '+16195551234' } };

    acceptIncomingCall(call, { screenPop });

    expect(screenPop).not.toHaveBeenCalled();
  });

  it('reads callerName from `customParameters` (a Map), not from `parameters`', () => {
    const screenPop = vi.fn();
    // `parameters.From` exists (standard Twilio param), but the name only
    // lives on the customParameters Map — the accept-time glue must read the
    // Map, not `parameters`, for the caller-match fields.
    const call = {
      parameters: { From: '+16195551234' },
      customParameters: new Map([
        ['callerName', 'Jane Doe'],
        ['recordId', '00Q000000000001AAA'],
      ]),
    };

    const plan = acceptIncomingCall(call, { screenPop });

    expect(plan.activeCall.recordName).toBe('Jane Doe');
  });
});
