/**
 * Finalizing an INBOUND row (plan 2026-10-16 inbound agent testing), from the end of its conversation or from the
 * stale-call sweeper: completed (failed only when the call itself failed), outcome = the status in the call's stored
 * details (filled in from the transcript just before, caller-details.test.ts), else `incomplete`, and never a `calls`
 * row, the after-call work (summary, Salesforce) or an opt-out. The sweeper closes an inbound row only once its live
 * entry is gone; a live call of any length is left alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DETAILS_TOOL_NAME } from './caller-details.js';
import { finalizeAiCall } from './service-finalize.js';
import { clearActiveCalls, getActiveCall, registerActiveCall } from './registry.js';
import { PLACED_STALE_MS, sweepStaleAiCalls, type SweeperDeps } from './sweeper.js';
import { activeEntry, CALL_SID, fakeStore, fakeTwilio, silentLog, type FakeStore, type FakeTwilio } from './testing.js';

const ID = '11111111-2222-4333-8444-555555555555';
const CALLER = '+16195550142';
const STARTED = new Date('2026-10-16T18:00:00Z');
const END = new Date('2026-10-16T18:04:10Z');

let store: FakeStore;
let afterCall: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  store = fakeStore();
  afterCall = vi.fn(async () => {});
  await store.insert({
    id: ID, orgId: 'o1', startedBy: 'admin-1', toE164: CALLER, fromE164: '+16197244374', isTest: true, direction: 'inbound',
    status: 'in_progress', callSid: CALL_SID, startedAt: STARTED, createdAt: STARTED,
  });
});
afterEach(() => clearActiveCalls());

const finalize = (over: Partial<Parameters<typeof finalizeAiCall>[2]> = {}) =>
  finalizeAiCall({ store, log: silentLog, afterCall }, ID, { callStatus: 'completed', durationSeconds: null, endedAt: END, ...over });

describe('finalizeAiCall — an inbound row', () => {
  it.each(['qualified', 'callback', 'disqualified', 'incomplete'] as const)('status %s stored → completed with that outcome', async (status) => {
    await store.mergeQualification(ID, { status, location: 'Oceanside' });
    const res = await finalize();
    expect(res.finalized).toBe(true);
    expect(store.rows.get(ID)).toMatchObject({ status: 'completed', outcome: status, endedAt: END, durationSeconds: 250 });
  });

  it('no status, or one that is not one of the four → incomplete', async () => {
    await finalize();
    expect(store.rows.get(ID)?.outcome).toBe('incomplete');
    await store.insert({ id: 'x2', orgId: 'o1', startedBy: 'a', toE164: CALLER, direction: 'inbound', isTest: true, status: 'in_progress', qualification: { status: 'hot' } });
    await finalizeAiCall({ store, log: silentLog }, 'x2', { callStatus: 'completed', durationSeconds: 12, endedAt: END });
    expect(store.rows.get('x2')).toMatchObject({ outcome: 'incomplete', durationSeconds: 12 });
  });

  it('the stored status replaces an outcome end_call wrote', async () => {
    await store.setOutcome(ID, 'do_not_call', null);
    await store.mergeQualification(ID, { status: 'qualified' });
    await finalize();
    expect(store.rows.get(ID)?.outcome).toBe('qualified');
  });

  it('never a calls row, never the after-call work, never an opt-out — even though the row has a CallSid', async () => {
    await store.setOutcome(ID, 'do_not_call', null);
    const res = await finalize();
    if (!res.finalized) throw new Error('not finalized');
    await res.after;
    expect(store.ctiCalls.size).toBe(0);
    expect(store.rows.get(ID)?.ctiCallId).toBeNull();
    expect(afterCall).not.toHaveBeenCalled();
    expect(store.optOuts).toEqual([]);
  });

  it('a row the bridge marked failed stays failed; a Twilio-failed call is failed', async () => {
    await store.markFailed(ID);
    await finalize();
    expect(store.rows.get(ID)).toMatchObject({ status: 'failed', outcome: 'incomplete' });
    await store.insert({ id: 'x3', orgId: 'o1', startedBy: 'a', toE164: CALLER, direction: 'inbound', isTest: true, status: 'queued' });
    await finalizeAiCall({ store, log: silentLog }, 'x3', { callStatus: 'canceled', durationSeconds: 0, endedAt: END });
    expect(store.rows.get('x3')).toMatchObject({ status: 'failed', outcome: 'incomplete' });
  });

  it('is idempotent, and tears down the live entry', async () => {
    registerActiveCall(activeEntry({ aiCallId: ID, direction: 'inbound', callSid: CALL_SID }));
    expect((await finalize()).finalized).toBe(true);
    expect(getActiveCall(ID)).toBeNull();
    await store.mergeQualification(ID, { status: 'qualified' });
    expect((await finalize()).finalized).toBe(false);
    expect(store.rows.get(ID)?.outcome).toBe('incomplete');
  });

  it("a stream that never started (no started_at): no duration of its own, Twilio's when given", async () => {
    store.rows.set(ID, { ...store.rows.get(ID)!, startedAt: null });
    await finalize();
    expect(store.rows.get(ID)?.durationSeconds).toBeNull();
    await store.insert({ id: 'x4', orgId: 'o1', startedBy: 'a', toE164: CALLER, direction: 'inbound', isTest: true, status: 'queued' });
    await finalizeAiCall({ store, log: silentLog }, 'x4', { callStatus: 'completed', durationSeconds: 7, endedAt: END });
    expect(store.rows.get('x4')?.durationSeconds).toBe(7);
  });
});

describe('the sweeper and inbound rows', () => {
  let tw: FakeTwilio;
  let deps: SweeperDeps;
  const minsAfterStart = (m: number) => new Date(STARTED.getTime() + m * 60_000);

  beforeEach(() => {
    tw = fakeTwilio();
    deps = { store, twilio: tw, isActive: (id) => getActiveCall(id) !== null, afterCall, now: () => minsAfterStart(4.5), log: silentLog };
  });

  it('never ends a live inbound call, however long it runs (4.5 minutes here, past the 3-minute placed rule)', async () => {
    expect(4.5 * 60_000).toBeGreaterThan(PLACED_STALE_MS);
    registerActiveCall(activeEntry({ aiCallId: ID, direction: 'inbound', callSid: CALL_SID }));
    tw.fetched.set(CALL_SID, { status: 'completed', durationSeconds: 1, answeredBy: null, endTime: null });
    expect(await sweepStaleAiCalls(deps)).toEqual({ checked: 0, finalized: 0 });
    expect(store.rows.get(ID)?.endedAt).toBeNull();
    expect(getActiveCall(ID)).not.toBeNull();
  });

  it('closes an inbound row whose live entry is gone (a restart, or a stream that never started), with no calls row', async () => {
    await store.mergeQualification(ID, { status: 'callback' });
    tw.fetched.set(CALL_SID, { status: 'completed', durationSeconds: 140, answeredBy: null, endTime: minsAfterStart(2.5) });
    expect(await sweepStaleAiCalls(deps)).toEqual({ checked: 1, finalized: 1 });
    expect(store.rows.get(ID)).toMatchObject({ status: 'completed', outcome: 'callback', durationSeconds: 140, endedAt: minsAfterStart(2.5) });
    expect(store.ctiCalls.size).toBe(0);
    expect(afterCall).not.toHaveBeenCalled();
  });

  it('fills in the details from the transcript before closing, when it is given the after-call model', async () => {
    store.rows.set(ID, { ...store.rows.get(ID)!, transcript: [{ role: 'caller', text: 'Please call me back on Monday.', at: STARTED.toISOString() }] });
    const create = vi.fn(async () => ({ content: [{ type: 'tool_use', id: 'tu_1', name: DETAILS_TOOL_NAME, input: { status: 'callback', best_callback_time: 'Monday' } }] }));
    tw.fetched.set(CALL_SID, { status: 'completed', durationSeconds: 140, answeredBy: null, endTime: minsAfterStart(2.5) });
    expect(await sweepStaleAiCalls({ ...deps, details: { client: { create }, model: 'm', log: silentLog } })).toEqual({ checked: 1, finalized: 1 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.rows.get(ID)).toMatchObject({ status: 'completed', outcome: 'callback', qualification: { status: 'callback', best_callback_time: 'Monday' } });
    expect(afterCall).not.toHaveBeenCalled();
  });

  it('an inbound call Twilio has no record of is closed failed, outcome incomplete', async () => {
    expect(await sweepStaleAiCalls(deps)).toEqual({ checked: 1, finalized: 1 });
    expect(store.rows.get(ID)).toMatchObject({ status: 'failed', outcome: 'incomplete' });
    expect(store.ctiCalls.size).toBe(0);
  });
});
