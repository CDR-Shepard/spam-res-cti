import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SWEEP_INTERVAL_MS,
  SWEEP_LIMIT,
  startAiCallSweeper,
  sweepStaleAiCalls,
  type SweeperDeps,
} from './sweeper.js';
import { CALL_SID, fakeStore, fakeTwilio, silentLog, type FakeStore, type FakeTwilio } from './testing.js';

const NOW = new Date('2026-10-05T19:00:00Z');
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let store: FakeStore;
let tw: FakeTwilio;
let active: Set<string>;
let afterCall: ReturnType<typeof vi.fn>;
let deps: SweeperDeps;

async function row(n: number, over: { createdMinsAgo: number; callSid?: string | null; status?: string; endedAt?: Date | null }) {
  await store.insert({
    id: ID(n),
    orgId: 'o1',
    startedBy: 'u1',
    toE164: '+16195550100',
    fromE164: '+16195550000',
    status: over.status ?? 'in_progress',
    callSid: over.callSid === undefined ? `CA${String(n).padStart(32, '0')}` : over.callSid,
    createdAt: minsAgo(over.createdMinsAgo),
    endedAt: over.endedAt ?? null,
  });
}

beforeEach(() => {
  store = fakeStore();
  tw = fakeTwilio();
  active = new Set();
  afterCall = vi.fn(async () => {});
  deps = { store, twilio: tw, isActive: (id) => active.has(id), afterCall, now: () => NOW, log: silentLog };
});

describe('sweepStaleAiCalls', () => {
  it('finalizes a placed call Twilio says has ended (the status callback was lost), with Twilio’s numbers', async () => {
    await row(1, { createdMinsAgo: 5 });
    tw.fetched.set(`CA${'1'.padStart(32, '0')}`, { status: 'completed', durationSeconds: 61, answeredBy: 'human', endTime: minsAgo(1) });
    expect(await sweepStaleAiCalls(deps)).toEqual({ checked: 1, finalized: 1 });
    expect(store.rows.get(ID(1))).toMatchObject({ status: 'completed', outcome: 'hung_up', durationSeconds: 61, endedAt: minsAgo(1), answeredBy: 'human' });
    expect(store.ctiCalls.size).toBe(1);
    expect(afterCall).toHaveBeenCalledTimes(1);
  });

  it('leaves a call Twilio says is still going', async () => {
    await row(1, { createdMinsAgo: 5 });
    tw.fetched.set(`CA${'1'.padStart(32, '0')}`, { status: 'in-progress', durationSeconds: null, answeredBy: null, endTime: null });
    expect(await sweepStaleAiCalls(deps)).toEqual({ checked: 1, finalized: 0 });
    expect(store.rows.get(ID(1))?.endedAt).toBeNull();
  });

  it('skips young rows, finished rows, and calls this process is still running', async () => {
    await row(1, { createdMinsAgo: 2 }); // placed, too young
    await row(2, { createdMinsAgo: 9, callSid: null, status: 'queued' }); // never placed, too young
    await row(3, { createdMinsAgo: 30, endedAt: minsAgo(25) }); // already finalized
    await row(4, { createdMinsAgo: 5 });
    active.add(ID(4)); // live in our registry
    tw.fetched.set(`CA${'4'.padStart(32, '0')}`, { status: 'completed', durationSeconds: 1, answeredBy: null, endTime: null });
    expect(await sweepStaleAiCalls(deps)).toEqual({ checked: 0, finalized: 0 });
    expect(store.rows.get(ID(4))?.endedAt).toBeNull();
  });

  it('a row with no CallSid after 10 minutes is finalized failed (and gets no calls row)', async () => {
    await row(1, { createdMinsAgo: 11, callSid: null, status: 'queued' });
    expect(await sweepStaleAiCalls(deps)).toEqual({ checked: 1, finalized: 1 });
    expect(store.rows.get(ID(1))).toMatchObject({ status: 'failed', outcome: 'failed', endedAt: NOW });
    expect(store.ctiCalls.size).toBe(0);
  });

  it('a call Twilio has no record of is finalized failed', async () => {
    await row(1, { createdMinsAgo: 5 }); // fakeTwilio: unknown sid → 404
    expect(await sweepStaleAiCalls(deps)).toEqual({ checked: 1, finalized: 1 });
    expect(store.rows.get(ID(1))).toMatchObject({ status: 'failed', outcome: 'failed' });
  });

  it('a transient Twilio error leaves the row for the next tick — unless it is hours old', async () => {
    await row(1, { createdMinsAgo: 5 });
    await row(2, { createdMinsAgo: 7 * 60 });
    tw.fetchCall = vi.fn(async () => Promise.reject(Object.assign(new Error('503'), { status: 503 })));
    expect(await sweepStaleAiCalls(deps)).toEqual({ checked: 2, finalized: 1 });
    expect(store.rows.get(ID(1))?.endedAt).toBeNull();
    expect(store.rows.get(ID(2))?.outcome).toBe('failed');
  });

  it(`looks at no more than ${SWEEP_LIMIT} rows per tick`, async () => {
    for (let i = 1; i <= SWEEP_LIMIT + 5; i++) await row(i, { createdMinsAgo: 20 + i, callSid: null, status: 'queued' });
    expect((await sweepStaleAiCalls(deps)).checked).toBe(SWEEP_LIMIT);
  });

  it('one bad row never stops the rest', async () => {
    await row(1, { createdMinsAgo: 30, callSid: null });
    await row(2, { createdMinsAgo: 20, callSid: null });
    const finalize = store.finalize.bind(store);
    store.finalize = async (id, w) => (id === ID(1) ? Promise.reject(new Error('db blip')) : finalize(id, w));
    expect(await sweepStaleAiCalls(deps)).toEqual({ checked: 2, finalized: 1 });
  });
});

describe('startAiCallSweeper', () => {
  const on = { OPENAI_API_KEY: 'sk', AI_VOICE: 'on', OUTREACH_KILL_SWITCH: 'off' } as const;
  afterEach(() => vi.useRealTimers());

  it('does not start when AI voice is unavailable', () => {
    expect(startAiCallSweeper({ ...on, AI_VOICE: 'off' } as never, silentLog, () => deps)).toBeNull();
    expect(startAiCallSweeper({ ...on, OPENAI_API_KEY: undefined } as never, silentLog, () => deps)).toBeNull();
  });

  it(`ticks every ${SWEEP_INTERVAL_MS / 1000} s, unref'd, never overlapping a slow tick`, async () => {
    vi.useFakeTimers();
    let calls = 0;
    let release!: () => void;
    store.staleOpen = vi.fn(async () => {
      calls += 1;
      await new Promise<void>((r) => (release = r));
      return [];
    });
    const timer = startAiCallSweeper(on as never, silentLog, () => deps);
    expect(timer).not.toBeNull();
    expect(timer!.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(calls).toBe(1); // still running
    release();
    await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
    expect(calls).toBe(2);
    clearInterval(timer!);
  });
});
