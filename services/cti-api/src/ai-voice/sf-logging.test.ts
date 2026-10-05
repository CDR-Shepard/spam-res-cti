import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SalesforceUnauthorizedError, type CallTaskInput } from '../salesforce/client.js';
import type { OwnershipSnapshot } from '../salesforce/ownership.js';
import {
  CALLBACK_TASK_STATUS,
  aiCallTaskInput,
  callbackTaskInput,
  logAiCallTask,
  logCallbackTask,
  withSalesforceEffects,
  type AiCallSfPort,
  type SfLogDeps,
} from './sf-logging.js';
import { defaultToolEffects } from './service-tools.js';
import type { AiCallRow } from './store.js';
import { CALL_SID, fakeStore, rowOf, silentLog, type FakeStore } from './testing.js';

const ID = '11111111-2222-4333-8444-555555555555';
const CTI = 'cccccccc-0000-4000-8000-000000000001';
const LEAD = '00Q5e00000AbCdEFGH';
const STARTER = 'aaaaaaaa-0000-4000-8000-000000000001';
const OWNER = 'aaaaaaaa-0000-4000-8000-000000000002';
const SF_STARTER = '005000000000001AAA';
const SF_OWNER = '005000000000002AAA';
const SUMMARY = 'Jane may sell.\n\nOutcome: Callback requested\nAI call id: x';

let store: FakeStore;
let created: Array<{ userId: string; input: CallTaskInput }>;
let owners: Map<string, OwnershipSnapshot>;
let sfUsers: Map<string, string>;
let sf: AiCallSfPort;
let deps: SfLogDeps;

function row(over: Partial<AiCallRow> = {}): AiCallRow {
  return rowOf({
    id: ID,
    orgId: 'o1',
    startedBy: STARTER,
    handoffUserId: OWNER,
    sfObject: 'Lead',
    sfRecordId: LEAD,
    toE164: '+16195550100',
    fromE164: '+16195550000',
    callSid: CALL_SID,
    ctiCallId: CTI,
    status: 'completed',
    outcome: 'not_interested',
    startedAt: new Date('2026-10-06T02:30:00Z'), // 7:30 PM Pacific on the 5th
    endedAt: new Date('2026-10-06T02:34:00Z'),
    durationSeconds: 240,
    ...over,
  });
}

beforeEach(async () => {
  store = fakeStore();
  await store.insert(row());
  created = [];
  owners = new Map([[LEAD, { type: 'Lead', ownerId: SF_STARTER }]]);
  sfUsers = new Map([
    [STARTER, SF_STARTER],
    [OWNER, SF_OWNER],
  ]);
  sf = {
    createCallTask: vi.fn(async (userId: string, input: CallTaskInput) => {
      created.push({ userId, input });
      return { taskId: `00T${created.length}` };
    }),
    fetchOwnership: vi.fn(async (_u: string, id: string) => owners.get(id) ?? ({ type: 'Lead', ownerId: null } as OwnershipSnapshot)),
    sfUserIdFor: vi.fn(async (u: string) => sfUsers.get(u) ?? null),
  };
  deps = { sf, store, log: silentLog, now: () => new Date('2026-10-06T03:00:00Z') };
});

describe('aiCallTaskInput', () => {
  it('the dialer connect-task shape, with the AI subject, disposition and description', () => {
    const input = aiCallTaskInput(row(), { whoId: LEAD }, SUMMARY);
    expect(input).toMatchObject({
      subject: 'AI call: Not interested',
      callType: 'Outbound',
      callDisposition: 'Connected',
      activityDate: '2026-10-05',
      whoId: LEAD,
      description: `${SUMMARY}\nTranscript in CTI: AI call ${ID}`,
      customFields: {
        External_Call_Id__c: CTI,
        Provider_Call_Id__c: CALL_SID,
        From_Number__c: '+16195550000',
        To_Number__c: '+16195550100',
        CTI_Provider__c: 'twilio',
      },
    });
    // AI talk time is not the rep's talk time.
    expect(input.callDurationInSeconds).toBeUndefined();
  });
});

describe('callbackTaskInput', () => {
  it('a scheduled callback: dated the callback day, open, says when', () => {
    const r = row({ outcome: 'qualified_callback', callbackAt: new Date('2026-10-08T00:00:00Z'), summary: 'x\nCallback requested: Tuesday 5 PM — after work' });
    const input = callbackTaskInput(r, { whoId: LEAD }, SUMMARY, new Date('2026-10-06T03:00:00Z'));
    expect(input.subject).toBe('AI call: callback Tuesday 5 PM');
    expect(input.activityDate).toBe('2026-10-07');
    expect(input.customFields).toMatchObject({ Status: CALLBACK_TASK_STATUS });
    expect(input.description).toBe(`${SUMMARY}\nTranscript in CTI: AI call ${ID}`);
  });

  it('an exact ISO time reads as words in the prospect’s zone', () => {
    const r = row({ outcome: 'qualified_callback', callbackAt: new Date('2026-10-08T00:00:00Z'), summary: 'Callback requested: 2026-10-07T17:00:00-07:00' });
    const input = callbackTaskInput(r, { whoId: LEAD }, SUMMARY, new Date('2026-10-06T03:00:00Z'));
    expect(input.subject).toBe('AI call: callback Wed, Oct 7, 5:00 PM');
    expect(input.activityDate).toBe('2026-10-07');
  });

  it('a date-only callback is that calendar day', () => {
    const r = row({ outcome: 'qualified_callback', callbackAt: new Date('2026-10-08T00:00:00Z'), summary: 'Callback requested: 2026-10-08' });
    const input = callbackTaskInput(r, { whoId: LEAD }, SUMMARY, new Date('2026-10-06T03:00:00Z'));
    expect(input.subject).toBe('AI call: callback 2026-10-08');
    expect(input.activityDate).toBe('2026-10-08');
  });

  it('a callback with no time: dated today', () => {
    const r = row({ outcome: 'qualified_callback', callbackAt: null, summary: null });
    const input = callbackTaskInput(r, { whoId: LEAD }, SUMMARY, new Date('2026-10-06T03:00:00Z'));
    expect(input.subject).toBe('AI call: callback requested');
    expect(input.activityDate).toBe('2026-10-05');
  });

  it('a missed transfer: "callback requested", today, and the promise in the description', () => {
    const input = callbackTaskInput(row({ outcome: 'transfer_failed' }), { whoId: LEAD }, SUMMARY, new Date('2026-10-06T03:00:00Z'));
    expect(input.subject).toBe('AI call: callback requested');
    expect(input.activityDate).toBe('2026-10-05');
    expect(input.description).toBe(`${SUMMARY}\nThe caller was promised a call back.\nTranscript in CTI: AI call ${ID}`);
  });
});

describe('logAiCallTask', () => {
  it('creates the Task as the starter after the ownership gate, and stores sf_task_id', async () => {
    expect(await logAiCallTask(row(), SUMMARY, deps)).toBe('00T1');
    expect(created).toHaveLength(1);
    expect(created[0]!.userId).toBe(STARTER);
    expect(sf.fetchOwnership).toHaveBeenCalledWith(STARTER, LEAD);
    expect(store.rows.get(ID)?.sfTaskId).toBe('00T1');
  });

  it('never for a test call, a call with no record, or a call that was never placed', async () => {
    expect(await logAiCallTask(row({ isTest: true, sfObject: null, sfRecordId: null }), SUMMARY, deps)).toBeNull();
    expect(await logAiCallTask(row({ isTest: true }), SUMMARY, deps)).toBeNull();
    expect(await logAiCallTask(row({ callSid: null }), SUMMARY, deps)).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('respects the dialer ownership rule: no Task on someone else’s record', async () => {
    owners.set(LEAD, { type: 'Lead', ownerId: '005OTHER000000AAA' });
    expect(await logAiCallTask(row(), SUMMARY, deps)).toBeNull();
    expect(created).toHaveLength(0);
    expect(store.rows.get(ID)?.sfTaskId).toBeNull();
  });

  it('a starter without Salesforce gets no Task', async () => {
    sfUsers.delete(STARTER);
    expect(await logAiCallTask(row(), SUMMARY, deps)).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('a Salesforce failure is logged and never thrown; sf_task_id stays null', async () => {
    const error = vi.fn();
    sf.createCallTask = vi.fn(async () => Promise.reject(new Error('UNABLE_TO_LOCK_ROW')));
    expect(await logAiCallTask(row(), SUMMARY, { ...deps, log: { ...silentLog, error } })).toBeNull();
    expect(error).toHaveBeenCalled();
    expect(store.rows.get(ID)?.sfTaskId).toBeNull();
  });
});

describe('logCallbackTask', () => {
  it('created by the hand-off user (the record owner) when they have Salesforce', async () => {
    owners.set(LEAD, { type: 'Lead', ownerId: SF_OWNER });
    expect(await logCallbackTask(row({ outcome: 'transfer_failed' }), SUMMARY, deps)).toBe('00T1');
    expect(created[0]!.userId).toBe(OWNER);
    expect(created[0]!.input.subject).toBe('AI call: callback requested');
    // The main Task's id is not overwritten by the callback Task.
    expect(store.rows.get(ID)?.sfTaskId).toBeNull();
  });

  it('falls back to the starter when the hand-off user has no Salesforce connection', async () => {
    sfUsers.delete(OWNER);
    await logCallbackTask(row({ outcome: 'qualified_callback' }), SUMMARY, deps);
    expect(created[0]!.userId).toBe(STARTER);
  });

  it('only for callback outcomes, never for test calls', async () => {
    expect(await logCallbackTask(row({ outcome: 'not_interested' }), SUMMARY, deps)).toBeNull();
    expect(await logCallbackTask(row({ outcome: 'transfer_failed', isTest: true }), SUMMARY, deps)).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('if the org refuses the open status, the callback Task is still made (completed)', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('Salesforce Task create failed: [{"errorCode":"INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST","message":"Status: bad value"}]'))
      .mockResolvedValueOnce({ taskId: '00T9' });
    sf.createCallTask = create;
    owners.set(LEAD, { type: 'Lead', ownerId: SF_OWNER });
    expect(await logCallbackTask(row({ outcome: 'transfer_failed' }), SUMMARY, deps)).toBe('00T9');
    expect(create).toHaveBeenCalledTimes(2);
    expect((create.mock.calls[1]![1] as CallTaskInput).customFields?.Status).toBeUndefined();
  });
});

describe('logCallbackTask: a hand-off user whose own Salesforce connection is gone', () => {
  const OPP = '0065e00000AbCdEFGH';
  const oppRow = () => row({ sfObject: 'Opportunity', sfRecordId: OPP, outcome: 'transfer_failed' });

  beforeEach(() => {
    // The hand-off user owns the Opportunity; the starter is its lead manager, so the starter may write on it.
    owners.set(OPP, { type: 'Opportunity', ownerId: SF_OWNER, leadManagerId: SF_STARTER });
    const lookup = sf.fetchOwnership;
    sf.fetchOwnership = vi.fn(async (userId: string, id: string) => {
      if (userId === OWNER) throw new SalesforceUnauthorizedError();
      return lookup(userId, id);
    });
  });

  it('creates it as the starter, assigned to the hand-off user (OwnerId), still Open', async () => {
    expect(await logCallbackTask(oppRow(), SUMMARY, deps)).toBe('00T1');
    expect(created).toHaveLength(1);
    expect(created[0]!.userId).toBe(STARTER);
    expect(created[0]!.input.customFields).toEqual({ Status: CALLBACK_TASK_STATUS, OwnerId: SF_OWNER });
  });

  it('if Salesforce refuses the OwnerId, it is created unassigned (the starter owns it)', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('Salesforce Task create failed: [{"errorCode":"INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY","fields":["OwnerId"]}]'))
      .mockResolvedValueOnce({ taskId: '00T7' });
    sf.createCallTask = create;
    expect(await logCallbackTask(oppRow(), SUMMARY, deps)).toBe('00T7');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0]).toBe(STARTER);
    expect((create.mock.calls[1]![1] as CallTaskInput).customFields).toEqual({ Status: CALLBACK_TASK_STATUS });
  });

  it('a hand-off user who is the starter gets no OwnerId', async () => {
    sf.fetchOwnership = vi.fn(async () => ({ type: 'Opportunity' as const, ownerId: SF_STARTER }));
    await logCallbackTask({ ...oppRow(), handoffUserId: STARTER }, SUMMARY, deps);
    expect(created[0]!.input.customFields).toEqual({ Status: CALLBACK_TASK_STATUS });
  });
});

describe('withSalesforceEffects', () => {
  it('a missed transfer on a call that already finalized creates the callback Task itself', async () => {
    await store.update(ID, { endedAt: new Date(), outcome: 'transfer_failed' } as never);
    owners.set(LEAD, { type: 'Lead', ownerId: SF_OWNER });
    const effects = withSalesforceEffects(defaultToolEffects, deps);
    const ctx = { store, aiCallId: ID, orgId: 'o1', toE164: '+16195550100', log: silentLog, now: () => new Date() };
    await effects.transferFailed(ctx, { finalized: true });
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.input.subject).toBe('AI call: callback requested');
  });

  it('a late missed transfer re-renders the finalized summary: the did-not-connect line and the new outcome words', async () => {
    const stale = `Jane wants an offer.\n\nOutcome: Transferred to rep\nAI call id: ${ID}`;
    await store.update(ID, { endedAt: new Date(), outcome: 'transfer_failed', summary: stale } as never);
    owners.set(LEAD, { type: 'Lead', ownerId: SF_OWNER });
    const effects = withSalesforceEffects(defaultToolEffects, deps);
    const ctx = { store, aiCallId: ID, orgId: 'o1', toE164: '+16195550100', log: silentLog, now: () => new Date() };
    await effects.transferFailed(ctx, { finalized: true });
    const want = [
      'Jane wants an offer.',
      'Transfer to a specialist did not connect — call them back.',
      '',
      'Outcome: Transfer missed — callback promised',
      `AI call id: ${ID}`,
    ].join('\n');
    expect(store.rows.get(ID)?.summary).toBe(want);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.input.description?.startsWith(want)).toBe(true);
  });

  it('on a live call it leaves the callback Task to finalize', async () => {
    const effects = withSalesforceEffects(defaultToolEffects, deps);
    const ctx = { store, aiCallId: ID, orgId: 'o1', toE164: '+16195550100', log: silentLog, now: () => new Date() };
    await effects.transferFailed(ctx, { finalized: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(created).toHaveLength(0);
    expect(store.rows.get(ID)?.summary).toContain('call them back');
  });
});
