/**
 * Plan 1D Part 6 (controller addition A, from Part 4 M-7): a test or practice call rings the admin's own phone. A
 * do-not-call said on it ends the call and is recorded as the outcome (the practice list shows it), but the number is never
 * opted out: that would suppress the admin's test number for every later call. Real calls are unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onAmd } from './routes-webhooks.js';
import { clearActiveCalls, registerActiveCall } from './registry.js';
import { finalizeAiCall } from './service-finalize.js';
import { defaultToolEffects, handleToolCall, type CallControl, type ToolCtx } from './service-tools.js';
import { activeEntry, CALL_SID, fakeStore, fakeTwilio, silentLog, type FakeStore, type FakeTwilio } from './testing.js';

const ID = '11111111-2222-4333-8444-555555555555';
const ORG = 'o1';
const TO = '+15125550111';
const NOW = new Date('2026-10-06T18:00:00Z');
const END = new Date('2026-10-06T18:05:00Z');

let store: FakeStore;
let twilio: FakeTwilio;
let closing: boolean;
let call: CallControl;

const settle = () => new Promise((r) => setTimeout(r, 0));
const ctxFor = (isTest: boolean): ToolCtx => ({ store, aiCallId: ID, orgId: ORG, toE164: TO, log: silentLog, now: () => NOW, slots: [], isTest });
const run = (isTest: boolean, name: Parameters<typeof handleToolCall>[0], args: unknown) =>
  handleToolCall(name, args, { ctx: ctxFor(isTest), effects: defaultToolEffects, call });

beforeEach(async () => {
  clearActiveCalls();
  store = fakeStore();
  twilio = fakeTwilio();
  closing = false;
  call = {
    callSid: CALL_SID,
    twilio,
    claimClose: () => (closing ? false : (closing = true)),
    waitForPlayback: vi.fn(async () => {}),
    stopStream: vi.fn(),
    transferTwiml: () => '<Response/>',
  };
  await store.insert({ id: ID, orgId: ORG, startedBy: 'u1', toE164: TO, status: 'in_progress', callSid: CALL_SID, isTest: true, practice: true });
});

describe('do-not-call on a test or practice call', () => {
  it('mark_do_not_call records do_not_call and keeps talking, but never opts the test number out', async () => {
    const res = await run(true, 'mark_do_not_call', { note: 'stop calling me' });
    expect(res).toEqual({ output: 'done — say a brief goodbye and end the call', then: 'continue' });
    expect(store.rows.get(ID)?.outcome).toBe('do_not_call');
    expect(store.optOuts).toEqual([]);
  });

  it('a wrong number on a practice call is recorded as wrong_number, with no opt-out', async () => {
    await run(true, 'mark_do_not_call', { note: 'wrong number' });
    expect(store.rows.get(ID)?.outcome).toBe('wrong_number');
    expect(store.optOuts).toEqual([]);
  });

  it('end_call(do_not_call) ends the call with that outcome and no opt-out', async () => {
    const res = await run(true, 'end_call', { outcome: 'do_not_call', summary: 'Asked us to stop.' });
    expect(res.then).toBe('hangup');
    await settle();
    expect(twilio.hangups).toEqual([CALL_SID]);
    expect(store.rows.get(ID)).toMatchObject({ outcome: 'do_not_call', summary: 'Asked us to stop.' });
    expect(store.optOuts).toEqual([]);
  });

  it('end_call(wrong_number) after mark_do_not_call: wrong_number, no opt-out', async () => {
    await run(true, 'mark_do_not_call', { note: 'not the owner' });
    await run(true, 'end_call', { outcome: 'wrong_number', summary: 'Wrong person.' });
    expect(store.rows.get(ID)?.outcome).toBe('wrong_number');
    expect(store.optOuts).toEqual([]);
  });

  it('a do-not-call when another closer owns the call writes no opt-out either', async () => {
    closing = true;
    await run(true, 'end_call', { outcome: 'do_not_call', summary: 'stop' });
    expect(store.optOuts).toEqual([]);
  });

  it('a real call is unchanged: the number is opted out', async () => {
    await run(false, 'mark_do_not_call', { note: 'stop calling me' });
    expect(store.optOuts).toEqual([{ orgId: ORG, e164: TO, note: 'stop calling me' }]);
  });

  it('a ToolCtx without isTest (older callers) is a real call', async () => {
    const { isTest: _omit, ...ctx } = ctxFor(false);
    await handleToolCall('mark_do_not_call', { note: 'stop' }, { ctx, effects: defaultToolEffects, call });
    expect(store.optOuts).toHaveLength(1);
  });
});

describe('finalize and AMD on a test or practice call', () => {
  it('finalize does not re-assert an opt-out for a test row that ended do_not_call', async () => {
    await store.update(ID, { outcome: 'do_not_call' });
    const res = await finalizeAiCall({ store, log: silentLog }, ID, { callStatus: 'completed', durationSeconds: 30, endedAt: END });
    expect(res.finalized).toBe(true);
    expect(store.rows.get(ID)?.outcome).toBe('do_not_call');
    expect(store.optOuts).toEqual([]);
  });

  it('finalize still re-asserts it for a real call', async () => {
    store.rows.set(ID, { ...store.rows.get(ID)!, isTest: false, practice: false, outcome: 'wrong_number' });
    await finalizeAiCall({ store, log: silentLog }, ID, { callStatus: 'completed', durationSeconds: 30, endedAt: END });
    expect(store.optOuts).toEqual([{ orgId: ORG, e164: TO, note: 'ai call: wrong number' }]);
  });

  it('a fax answer on the admin\'s test number is hung up and recorded, but not opted out', async () => {
    registerActiveCall(activeEntry({ aiCallId: ID, orgId: ORG, callSid: CALL_SID, toE164: TO, isTest: true }));
    const deps = { store, twilio, effects: defaultToolEffects, now: () => NOW, log: silentLog };
    await onAmd(store.rows.get(ID)!, 'fax', deps);
    expect(twilio.hangups).toEqual([CALL_SID]);
    expect(store.rows.get(ID)?.outcome).toBe('wrong_number');
    expect(store.optOuts).toEqual([]);
  });
});
