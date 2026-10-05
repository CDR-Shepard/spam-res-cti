import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { derivedOutcome, finalizeAiCall, isTerminalCallStatus, mapCallStatus } from './service-finalize.js';
import { clearActiveCalls, getActiveCall, registerActiveCall } from './registry.js';
import { activeEntry, fakeStore, silentLog, type FakeStore } from './testing.js';

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

  it('keeps a tool outcome; a completed transfer becomes status transferred', async () => {
    await store.update(ID, { status: 'transferring', outcome: 'qualified_transferred' });
    await finalizeAiCall(deps(), ID, { callStatus: 'completed', durationSeconds: 300, endedAt: END });
    expect(store.rows.get(ID)).toMatchObject({ status: 'transferred', outcome: 'qualified_transferred' });
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

  it('an unknown id finalizes nothing', async () => {
    expect((await finalizeAiCall(deps(), 'nope', { callStatus: 'completed', durationSeconds: 1, endedAt: END })).finalized).toBe(false);
  });
});
