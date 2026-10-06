import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { afterAiCall, ctiCallValues, derivedOutcome, finalizeAiCall, isTerminalCallStatus, mapCallStatus } from './service-finalize.js';
import { clearActiveCalls, getActiveCall, registerActiveCall } from './registry.js';
import type { AiCallRow } from './store.js';
import { activeEntry, fakeStore, rowOf, silentLog, type FakeStore } from './testing.js';

const ID = '11111111-2222-4333-8444-555555555555';
const END = new Date('2026-10-05T18:05:00Z');
let store: FakeStore;

beforeEach(async () => {
  store = fakeStore();
  await store.insert({ id: ID, orgId: 'o1', startedBy: 'u1', toE164: '+16195550100', status: 'in_progress' });
});
afterEach(() => clearActiveCalls());

describe('derivedOutcome', () => {
  it.each([
    ['no-answer', null, 'no_answer'],
    ['busy', null, 'busy'],
    ['failed', null, 'failed'],
    ['canceled', null, 'failed'],
    ['completed', 'machine_end_beep', 'voicemail'],
    ['completed', 'fax', 'wrong_number'],
    ['completed', 'human', 'hung_up'],
    ['completed', null, 'hung_up'],
  ] as const)('%s / %s → %s', (status, answeredBy, want) => {
    expect(derivedOutcome(status, answeredBy)).toBe(want);
  });
});

describe('call status mapping', () => {
  it('maps Twilio CallStatus to a row status or a terminal', () => {
    expect(mapCallStatus('ringing')).toBe('ringing');
    expect(mapCallStatus('in-progress')).toBe('in_progress');
    expect(mapCallStatus('queued')).toBeNull();
    expect(mapCallStatus('initiated')).toBeNull();
    for (const s of ['completed', 'busy', 'no-answer', 'failed', 'canceled']) expect(isTerminalCallStatus(s)).toBe(true);
    expect(isTerminalCallStatus('in-progress')).toBe(false);
  });
});

describe('finalizeAiCall', () => {
  const deps = () => ({ store, log: silentLog });

  it('derives the outcome when no tool set one, stamps the end, and is idempotent', async () => {
    const first = await finalizeAiCall(deps(), ID, { callStatus: 'no-answer', durationSeconds: 0, endedAt: END });
    expect(first.finalized).toBe(true);
    expect(store.rows.get(ID)).toMatchObject({ status: 'completed', outcome: 'no_answer', endedAt: END, durationSeconds: 0 });
    const again = await finalizeAiCall(deps(), ID, { callStatus: 'completed', durationSeconds: 99, endedAt: new Date() });
    expect(again.finalized).toBe(false);
    expect(store.rows.get(ID)?.outcome).toBe('no_answer');
  });

  it('keeps a tool outcome', async () => {
    await store.update(ID, { outcome: 'not_interested' });
    await finalizeAiCall(deps(), ID, { callStatus: 'completed', durationSeconds: 300, endedAt: END });
    expect(store.rows.get(ID)).toMatchObject({ status: 'completed', outcome: 'not_interested' });
  });

  it('a transfer that rang out finishes completed / transfer_failed', async () => {
    await store.update(ID, { status: 'transferring', outcome: 'transfer_failed' });
    await finalizeAiCall(deps(), ID, { callStatus: 'completed', durationSeconds: 60, endedAt: END });
    expect(store.rows.get(ID)).toMatchObject({ status: 'completed', outcome: 'transfer_failed' });
  });

  it('a machine answer recorded by AMD finishes as voicemail', async () => {
    await store.update(ID, { answeredBy: 'machine_end_beep' });
    await finalizeAiCall(deps(), ID, { callStatus: 'completed', durationSeconds: 40, endedAt: END });
    expect(store.rows.get(ID)?.outcome).toBe('voicemail');
  });

  it('a failed call finishes status failed', async () => {
    await finalizeAiCall(deps(), ID, { callStatus: 'failed', durationSeconds: null, endedAt: END });
    expect(store.rows.get(ID)).toMatchObject({ status: 'failed', outcome: 'failed' });
  });

  it('flushes the transcript, stops the bridge and drops the registry entry BEFORE the row is closed', async () => {
    const order: string[] = [];
    const bridge = { start: vi.fn(), silence: vi.fn(), waitForPlayback: vi.fn(), stop: vi.fn(() => order.push('stop')) };
    const transcript = { close: vi.fn(async () => void order.push('flush')) };
    registerActiveCall(activeEntry({ aiCallId: ID, bridge, transcript: transcript as never }));
    const fin = store.finalize.bind(store);
    store.finalize = async (id, w) => {
      order.push('finalize');
      return fin(id, w);
    };
    await finalizeAiCall(deps(), ID, { callStatus: 'completed', durationSeconds: 10, endedAt: END });
    expect(order).toEqual(['stop', 'flush', 'finalize']);
    expect(getActiveCall(ID)).toBeNull();
  });

  it('a do_not_call call re-asserts the opt-out at the end (belt and braces)', async () => {
    await store.update(ID, { outcome: 'do_not_call' });
    await finalizeAiCall(deps(), ID, { callStatus: 'completed', durationSeconds: 10, endedAt: END });
    expect(store.optOuts).toEqual([{ orgId: 'o1', e164: '+16195550100', note: 'ai call: do not call' }]);
  });

  it('a wrong_number call re-asserts the opt-out too', async () => {
    await store.update(ID, { outcome: 'wrong_number' });
    await finalizeAiCall(deps(), ID, { callStatus: 'completed', durationSeconds: 10, endedAt: END });
    expect(store.optOuts).toEqual([{ orgId: 'o1', e164: '+16195550100', note: 'ai call: wrong number' }]);
  });

  it('no opt-out for other outcomes', async () => {
    await store.update(ID, { outcome: 'voicemail' });
    await finalizeAiCall(deps(), ID, { callStatus: 'completed', durationSeconds: 10, endedAt: END });
    expect(store.optOuts).toEqual([]);
  });

  it('an unknown id finalizes nothing', async () => {
    expect((await finalizeAiCall(deps(), 'nope', { callStatus: 'completed', durationSeconds: 1, endedAt: END })).finalized).toBe(false);
  });
});

describe('finalize, Task 7: the calls row, the after-call work, the transfer status', () => {
  const SID = `CA${'b'.repeat(32)}`;
  const deps = (afterCall?: (row: AiCallRow) => Promise<void>) => ({ store, log: silentLog, ...(afterCall ? { afterCall } : {}) });

  beforeEach(async () => {
    await store.update(ID, { callSid: SID, fromE164: '+16195550000', startedAt: new Date('2026-10-05T18:00:30Z') });
    store.rows.set(ID, { ...store.rows.get(ID)!, sfObject: 'Lead', sfRecordId: '00Q5e00000AbCdEFGH', handoffUserId: 'u2' });
  });

  it('writes ONE outbound calls row (so the dialer caps count it) and links it via cti_call_id', async () => {
    await store.update(ID, { outcome: 'not_interested' });
    const res = await finalizeAiCall(deps(), ID, { callStatus: 'completed', durationSeconds: 95, endedAt: END });
    expect(res.finalized).toBe(true);
    expect(store.ctiCalls.size).toBe(1);
    const [call] = [...store.ctiCalls.values()];
    expect(call).toMatchObject({
      orgId: 'o1',
      userId: 'u1',
      provider: 'twilio',
      providerCallId: SID,
      direction: 'outbound',
      fromNumber: '+16195550000',
      toNumber: '+16195550100',
      normalizedToNumber: '+16195550100',
      status: 'completed',
      durationSeconds: 95,
      talkSeconds: 0,
      disposition: 'Connected',
      salesforceWhoId: '00Q5e00000AbCdEFGH',
      salesforceWhatId: null,
      campaignKey: null,
      metadata: { ai: true, aiCallId: ID, outcome: 'not_interested' },
      endedAt: END,
    });
    expect(store.rows.get(ID)?.ctiCallId).toBe(call!.id);
    if (res.finalized) expect(res.row.ctiCallId).toBe(call!.id);
  });

  it('a second finalize writes nothing (idempotent)', async () => {
    await finalizeAiCall(deps(), ID, { callStatus: 'no-answer', durationSeconds: 0, endedAt: END });
    const again = await finalizeAiCall(deps(), ID, { callStatus: 'completed', durationSeconds: 3, endedAt: END });
    expect(again.finalized).toBe(false);
    expect(store.ctiCalls.size).toBe(1);
  });

  it.each([
    ['no-answer', 'no_answer', 'No answer'],
    ['busy', 'busy', 'Busy'],
    ['failed', 'failed', 'Failed'],
    ['canceled', 'canceled', 'Failed'],
  ])('Twilio %s → calls.status %s, disposition %s', async (callStatus, status, disposition) => {
    await finalizeAiCall(deps(), ID, { callStatus, durationSeconds: 0, endedAt: END });
    expect([...store.ctiCalls.values()][0]).toMatchObject({ status, disposition });
  });

  it('a call that was never placed (no CallSid anywhere) gets no calls row', async () => {
    store.rows.set(ID, { ...store.rows.get(ID)!, callSid: null });
    await finalizeAiCall(deps(), ID, { callStatus: 'failed', durationSeconds: null, endedAt: END });
    expect(store.ctiCalls.size).toBe(0);
    expect(store.rows.get(ID)?.endedAt).toEqual(END);
  });

  it('stores the CallSid from the callback when the row never got one, and uses it for the calls row', async () => {
    store.rows.set(ID, { ...store.rows.get(ID)!, callSid: null });
    await finalizeAiCall(deps(), ID, { callStatus: 'completed', durationSeconds: 4, endedAt: END, callSid: SID });
    expect(store.rows.get(ID)?.callSid).toBe(SID);
    expect([...store.ctiCalls.values()][0]?.providerCallId).toBe(SID);
  });

  it('a calls-row failure is logged and the call is still finalized', async () => {
    const error = vi.fn();
    store.recordCtiCall = async () => Promise.reject(new Error('db blip'));
    const res = await finalizeAiCall({ store, log: { ...silentLog, error } }, ID, { callStatus: 'completed', durationSeconds: 4, endedAt: END });
    expect(res.finalized).toBe(true);
    expect(error).toHaveBeenCalled();
  });

  it('the after-call work (summary, Salesforce) runs detached: finalize does not wait for it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const afterCall = vi.fn(async () => gate);
    const res = await finalizeAiCall(deps(afterCall), ID, { callStatus: 'completed', durationSeconds: 4, endedAt: END });
    expect(res.finalized).toBe(true);
    expect(afterCall).toHaveBeenCalledTimes(1);
    expect((afterCall.mock.calls[0] as unknown as [AiCallRow])[0].ctiCallId).toBeTruthy();
    release();
    if (res.finalized) await res.after;
  });

  it('an after-call failure never escapes', async () => {
    const res = await finalizeAiCall(deps(async () => Promise.reject(new Error('boom'))), ID, { callStatus: 'completed', durationSeconds: 4, endedAt: END });
    if (res.finalized) await expect(res.after).resolves.toBeUndefined();
  });

  it('finalize never sets transferred itself: a transfer still in flight ends completed / qualified_transferred', async () => {
    await store.update(ID, { status: 'transferring', outcome: 'qualified_transferred' });
    await finalizeAiCall(deps(), ID, { callStatus: 'completed', durationSeconds: 300, endedAt: END });
    expect(store.rows.get(ID)).toMatchObject({ status: 'completed', outcome: 'qualified_transferred' });
  });

  it('keeps transferred when the transfer-result already confirmed the rep answered', async () => {
    await store.update(ID, { status: 'transferred', outcome: 'qualified_transferred' });
    await finalizeAiCall(deps(), ID, { callStatus: 'completed', durationSeconds: 300, endedAt: END });
    expect(store.rows.get(ID)?.status).toBe('transferred');
  });
});

describe('ctiCallValues', () => {
  it("is created at the AI call's creation time, so a late (sweeper) finalize does not move it in the 24 h cap window", () => {
    const createdAt = new Date('2026-10-05T09:00:00Z');
    const row = { ...rowOf({ id: ID, orgId: 'o1', startedBy: 'u1', toE164: '+16195550100' }), callSid: 'CA1', createdAt };
    expect(ctiCallValues(row as AiCallRow, 'completed').createdAt).toEqual(createdAt);
  });

  it('a test call is still a calls row (it rang a real phone), with no Salesforce links', () => {
    const row = { ...rowOf({ id: ID, orgId: 'o1', startedBy: 'u1', toE164: '+16195550100' }), isTest: true, callSid: 'CA1', outcome: 'hung_up' };
    expect(ctiCallValues(row as AiCallRow, 'completed')).toMatchObject({ salesforceWhoId: null, salesforceWhatId: null, disposition: 'Connected' });
  });

  it('a practice call (plan 1D) carries the record ids on ai_calls but its calls row links to no record: it rang a test number', () => {
    const row = {
      ...rowOf({ id: ID, orgId: 'o1', startedBy: 'u1', toE164: '+16195550100' }),
      isTest: true, practice: true, sfObject: 'Lead', sfRecordId: '00Q5e00000AbCdEFGH', callSid: 'CA1', outcome: 'appointment_set',
    };
    expect(ctiCallValues(row as AiCallRow, 'completed')).toMatchObject({ salesforceWhoId: null, salesforceWhatId: null, disposition: 'Connected' });
  });

  it('an Opportunity is the What', () => {
    const row = { ...rowOf({ id: ID, orgId: 'o1', startedBy: 'u1', toE164: '+16195550100' }), sfObject: 'Opportunity', sfRecordId: '0065e00000AbCdEFGH', callSid: 'CA1' };
    expect(ctiCallValues(row as AiCallRow, 'completed')).toMatchObject({ salesforceWhoId: null, salesforceWhatId: '0065e00000AbCdEFGH' });
  });
});

describe('afterAiCall', () => {
  const SID = `CA${'b'.repeat(32)}`;
  const record = (over: Partial<AiCallRow> = {}): AiCallRow =>
    ({ ...store.rows.get(ID)!, callSid: SID, sfObject: 'Lead', sfRecordId: '00Q5e00000AbCdEFGH', outcome: 'qualified_callback', summary: 'Callback requested: Thursday', ...over }) as AiCallRow;

  it('writes the summary, then the call Task and (for a callback) the callback Task', async () => {
    const order: string[] = [];
    const sf = {
      createCallTask: vi.fn(async (_u: string, input: { subject: string }) => {
        order.push(input.subject);
        return { taskId: `00T${order.length}` };
      }),
      fetchOwnership: vi.fn(async () => ({ type: 'Lead' as const, ownerId: 'SF1' })),
      sfUserIdFor: vi.fn(async () => 'SF1'),
    };
    await afterAiCall(record(), { store, log: silentLog, summary: { client: null, model: 'm', log: silentLog }, sf: { sf, store, log: silentLog, now: () => END } });
    expect(store.rows.get(ID)?.summary).toBe(`Callback requested: Thursday\n\nOutcome: Callback requested\nAI call id: ${ID}`);
    expect(order).toEqual(['AI call: Callback requested', 'AI call: callback Thursday']);
    expect(store.rows.get(ID)?.sfTaskId).toBe('00T1');
  });

  it('a transfer that rang out while the summary was being written: the stored summary and the call Task use the new outcome', async () => {
    const MISSED = 'Transfer to a specialist did not connect — call them back.';
    // The late transfer-result already ran (failTransfer + its summary) before this snapshot's write.
    await store.update(ID, { outcome: 'transfer_failed', summary: `Wants an offer.\n${MISSED}` } as never);
    const subjects: string[] = [];
    const sf = {
      createCallTask: vi.fn(async (_u: string, input: { subject: string }) => {
        subjects.push(input.subject);
        return { taskId: `00T${subjects.length}` };
      }),
      fetchOwnership: vi.fn(async () => ({ type: 'Lead' as const, ownerId: 'SF1' })),
      sfUserIdFor: vi.fn(async () => 'SF1'),
    };
    const snapshot = record({ outcome: 'qualified_transferred', summary: 'Wants an offer.' });
    await afterAiCall(snapshot, { store, log: silentLog, summary: { client: null, model: 'm', log: silentLog }, sf: { sf, store, log: silentLog, now: () => END } });
    expect(store.rows.get(ID)?.summary).toBe(`Wants an offer.\n${MISSED}\n\nOutcome: Transfer missed — callback promised\nAI call id: ${ID}`);
    // The late path owns the callback Task; afterAiCall makes only the call's Task.
    expect(subjects).toEqual(['AI call: Transfer missed — callback promised']);
  });

  it('a practice call (plan 1D) writes nothing to Salesforce, even a callback on the real record', async () => {
    const sf = {
      createCallTask: vi.fn(async () => ({ taskId: '00T1' })),
      fetchOwnership: vi.fn(async () => ({ type: 'Lead' as const, ownerId: 'SF1' })),
      sfUserIdFor: vi.fn(async () => 'SF1'),
    };
    await afterAiCall(record({ isTest: true, practice: true }), { store, log: silentLog, summary: { client: null, model: 'm', log: silentLog }, sf: { sf, store, log: silentLog, now: () => END } });
    expect(sf.createCallTask).not.toHaveBeenCalled();
    expect(store.rows.get(ID)?.sfTaskId ?? null).toBeNull();
  });

  it('without Salesforce (or for a test call) only the summary is written', async () => {
    await afterAiCall(record({ outcome: 'no_answer', summary: null }), { store, log: silentLog, summary: { client: null, model: 'm', log: silentLog }, sf: null });
    expect(store.rows.get(ID)?.summary).toBe(`AI call — No answer\n\nOutcome: No answer\nAI call id: ${ID}`);
  });
});
