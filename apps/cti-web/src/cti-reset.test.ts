import { describe, expect, it } from 'vitest';
import type { StorageLike } from './audio-devices';
import {
  clearFlag,
  DeviceRefusedError,
  isBusyForReset,
  performReset,
  readFlag,
  RESET_NOTICE_KEY,
  RESET_WIPE_KEYS,
  RESETTING_TEXT,
  SOUND_CHECK_DUE_KEY,
  storedSessionToken,
  wipeForReset,
  type PerformResetDeps,
  type ResetBusySnapshot,
} from './cti-reset';

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  constructor(readonly log: string[] = []) {}
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.log.push(`set ${key}`); this.data.set(key, value); }
  removeItem(key: string): void { this.log.push(`remove ${key}`); this.data.delete(key); }
}
const session = (token: string): string => JSON.stringify({ token, userId: 'u1', email: 'rep@x.com' });

const IDLE: ResetBusySnapshot = {
  phase: 'idle', pendingDisposition: false, placing: false, takingCallback: false, incoming: false,
  connection: null, dialerConn: false, dialerLive: false, dialerSessionId: null, dialerRunStatus: null,
  runStarting: false, callbackWaiting: false, parkedRunId: null,
};

describe('isBusyForReset — a reset never lands on any of these (spec decision 5, controller ruling R1)', () => {
  it('idle and preflight are idle', () => {
    expect(isBusyForReset(IDLE)).toBe(false);
    expect(isBusyForReset({ ...IDLE, phase: 'preflight' })).toBe(false);
  });

  const BUSY: Array<[string, Partial<ResetBusySnapshot>]> = [
    ['ringing', { phase: 'ringing' }],
    ['on a call', { phase: 'active' }],
    ['in wrap-up (the wrap-up form is open)', { phase: 'wrapup' }],
    ['placing a call', { placing: true }],
    ['taking a callback', { takingCallback: true }],
    ['an inbound call ringing', { incoming: true }],
    ['a live connection', { connection: { status: () => 'open' } }],
    ['a connection that cannot say its status', { connection: {} }],
    ['the power-dial leg', { dialerConn: true }],
    ['a live run', { dialerLive: true }],
    // C1(c): Start dialing's prepare → start → join. The server may already be
    // ringing a prospect for a leg that has not joined yet.
    ['a run start in flight (prepare → start → join)', { runStarting: true }],
    ['a dialer run whose latest snapshot status is active', { dialerSessionId: 'sess-1', dialerRunStatus: 'active' }],
    ['a dialer run whose latest snapshot status is paused', { dialerSessionId: 'sess-1', dialerRunStatus: 'paused' }],
    ['a callback waiting on the banner', { callbackWaiting: true }],
    ['a run parked for a callback', { parkedRunId: 'sess-1' }],
  ];
  it.each(BUSY)('%s is busy', (_label, over) => {
    expect(isBusyForReset({ ...IDLE, ...over })).toBe(true);
  });

  it('a CLOSED connection left on the ref after the call is idle', () => {
    expect(isBusyForReset({ ...IDLE, connection: { status: () => 'closed' } })).toBe(false);
  });

  // Controller ruling R1 overrides the brief here: neither of these blocks a
  // reset, though the brief's original isBusyForReset treated both as busy.
  const NOT_BUSY: Array<[string, Partial<ResetBusySnapshot>]> = [
    ['an old pendingDisposition that is not the open wrap-up form', { pendingDisposition: true }],
    ["a terminal (stopped) run's dialerSessionId, or its summary screen", { dialerSessionId: 'sess-1', dialerRunStatus: 'stopped' }],
    ["a terminal (done) run's dialerSessionId, or its summary screen", { dialerSessionId: 'sess-1', dialerRunStatus: 'done' }],
    ["a run that hasn't started yet (status 'ready')", { dialerSessionId: 'sess-1', dialerRunStatus: 'ready' }],
  ];
  it.each(NOT_BUSY)('%s is NOT busy — a reset may proceed', (_label, over) => {
    expect(isBusyForReset({ ...IDLE, ...over })).toBe(false);
  });
});

describe('RESET_WIPE_KEYS', () => {
  it('is exactly the four keys the softphone keeps', () => {
    expect(RESET_WIPE_KEYS).toEqual(['cti.session.v1', 'cti.displayName', 'cti.audio.input', 'cti.audio.output']);
  });
});

describe('storedSessionToken', () => {
  it("reads the stored session's token; null when there is none or it is unreadable", () => {
    const s = new MemoryStorage();
    expect(storedSessionToken(s)).toBeNull();
    s.data.set('cti.session.v1', session('tok'));
    expect(storedSessionToken(s)).toBe('tok');
    s.data.set('cti.session.v1', 'not json');
    expect(storedSessionToken(s)).toBeNull();
    expect(storedSessionToken(null)).toBeNull();
  });
});

describe('wipeForReset — the wipe, then the flags (they survive into the reloaded page)', () => {
  it('removes every softphone key, THEN writes both flags, and leaves anything else alone', () => {
    const s = new MemoryStorage();
    s.data.set('cti.session.v1', session('tok'));
    s.data.set('cti.displayName', 'Ada');
    s.data.set('cti.audio.input', 'jabra');
    s.data.set('cti.audio.output', 'spk-jabra');
    s.data.set('other', 'kept');
    expect(wipeForReset('tok', s)).toBe(true);
    expect(s.log).toEqual([
      'remove cti.session.v1', 'remove cti.displayName', 'remove cti.audio.input', 'remove cti.audio.output',
      'set cti.soundCheck.due', 'set cti.reset.notice',
    ]);
    expect([...s.data]).toEqual([['other', 'kept'], ['cti.soundCheck.due', '1'], ['cti.reset.notice', '1']]);
  });

  it('storage another tab already wiped: still writes the flags', () => {
    const s = new MemoryStorage();
    expect(wipeForReset('tok', s)).toBe(true);
    expect(s.data.get(SOUND_CHECK_DUE_KEY)).toBe('1');
    expect(s.data.get(RESET_NOTICE_KEY)).toBe('1');
  });

  it('a DIFFERENT session in storage (the rep signed in again elsewhere) is never touched', () => {
    const s = new MemoryStorage();
    s.data.set('cti.session.v1', session('newer'));
    s.data.set('cti.audio.input', 'jabra');
    expect(wipeForReset('tok', s)).toBe(false);
    expect(s.log).toEqual([]);
  });

  it('an unreadable session value counts as ours and is wiped', () => {
    const s = new MemoryStorage();
    s.data.set('cti.session.v1', 'not json');
    expect(wipeForReset('tok', s)).toBe(true);
    expect(s.data.has('cti.session.v1')).toBe(false);
  });

  it('no storage, or storage that throws: false, and it never throws', () => {
    expect(wipeForReset('tok', null)).toBe(false);
    const broken: StorageLike = { getItem: () => { throw new Error('blocked'); }, setItem: () => {}, removeItem: () => {} };
    expect(wipeForReset('tok', broken)).toBe(false);
  });
});

describe('readFlag / clearFlag', () => {
  it("reads '1' as set, anything else as not; clear removes it; blocked storage is harmless", () => {
    const s = new MemoryStorage();
    expect(readFlag(RESET_NOTICE_KEY, s)).toBe(false);
    s.data.set(RESET_NOTICE_KEY, '1');
    expect(readFlag(RESET_NOTICE_KEY, s)).toBe(true);
    clearFlag(RESET_NOTICE_KEY, s);
    expect(readFlag(RESET_NOTICE_KEY, s)).toBe(false);
    const broken: StorageLike = { getItem: () => { throw new Error('blocked'); }, setItem: () => {}, removeItem: () => { throw new Error('blocked'); } };
    expect(readFlag(RESET_NOTICE_KEY, broken)).toBe(false);
    expect(() => clearFlag(RESET_NOTICE_KEY, broken)).not.toThrow();
    expect(readFlag(RESET_NOTICE_KEY, null)).toBe(false);
  });
});

describe('performReset — the order is the contract (spec decision 4)', () => {
  function recorder(over: Partial<PerformResetDeps> = {}) {
    const events: string[] = [];
    const deps: PerformResetDeps = {
      beginResetting: () => { events.push('latch'); },
      teardownDevice: () => { events.push('teardown'); },
      sessionIsOurs: () => true,
      postResetComplete: async () => { events.push('post reset-complete'); },
      isBusy: () => { events.push('re-check'); return false; },
      whenIdle: async () => { events.push('idle again'); },
      broadcastReset: () => { events.push('broadcast'); },
      wipe: () => { events.push('wipe + flags'); return true; },
      reload: () => { events.push('reload'); },
      warn: () => { events.push('warn'); },
      ...over,
    };
    return { events, deps };
  }

  it('the tab that starts it: latch → teardown → POST → re-check → broadcast → wipe + flags → reload', async () => {
    const r = recorder();
    await performReset(r.deps, true);
    expect(r.events).toEqual(['latch', 'teardown', 'post reset-complete', 're-check', 'broadcast', 'wipe + flags', 'reload']);
  });

  // C1(a): the latch is set BEFORE the Device goes down, synchronously — so
  // nothing (the online handler, a leadership change, place()) can build a new
  // Device in the up-to-5 s the POST is in flight.
  it('the latch and the teardown happen synchronously, before the first await', () => {
    const r = recorder();
    r.deps.postResetComplete = () => { r.events.push('post reset-complete'); return new Promise<void>(() => {}); };
    void performReset(r.deps, true);
    expect(r.events).toEqual(['latch', 'teardown', 'post reset-complete']);
  });

  // C1(d): the tab was idle when the reset began, but the POST takes up to 5 s.
  // If it picked something up meanwhile, nothing is broadcast, wiped or
  // reloaded until it is idle again.
  it('busy again after the POST: waits until idle, THEN broadcast → wipe + flags → reload', async () => {
    let idle: () => void = () => {};
    const r = recorder({
      isBusy: () => { r.events.push('re-check (busy)'); return true; },
      whenIdle: () => new Promise<void>((resolve) => { idle = () => { r.events.push('idle again'); resolve(); }; }),
    });
    const done = performReset(r.deps, true);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(r.events).toEqual(['latch', 'teardown', 'post reset-complete', 're-check (busy)']);
    idle();
    await done;
    expect(r.events).toEqual(['latch', 'teardown', 'post reset-complete', 're-check (busy)', 'idle again', 'broadcast', 'wipe + flags', 'reload']);
  });

  it('a failed POST does not stop it — the next sign-in ends the reset anyway', async () => {
    const r = recorder();
    r.deps.postResetComplete = async () => { r.events.push('post reset-complete'); throw new Error('API 401'); };
    await performReset(r.deps, true);
    expect(r.events).toEqual(['latch', 'teardown', 'post reset-complete', 'warn', 're-check', 'broadcast', 'wipe + flags', 'reload']);
  });

  it('a broadcast that throws (channel closed) still wipes and reloads', async () => {
    const r = recorder();
    r.deps.broadcastReset = () => { r.events.push('broadcast'); throw new Error('InvalidStateError'); };
    await performReset(r.deps, true);
    expect(r.events).toEqual(['latch', 'teardown', 'post reset-complete', 're-check', 'broadcast', 'warn', 'wipe + flags', 'reload']);
  });

  it('a peer finishing: latch and teardown, no POST, no broadcast', async () => {
    const r = recorder();
    await performReset(r.deps, false);
    expect(r.events).toEqual(['latch', 'teardown', 'wipe + flags', 'reload']);
  });

  it('a stale tab (storage no longer holds its session) neither POSTs nor broadcasts — it can never reset a newer session', async () => {
    const r = recorder({ sessionIsOurs: () => false });
    await performReset(r.deps, true);
    expect(r.events).toEqual(['latch', 'teardown', 'wipe + flags', 'reload']);
  });
});

describe('DeviceRefusedError — a quiet refusal, never a toast', () => {
  it('while resetting it says so in the one quiet line; torn down mid-build it says to try again', () => {
    const resetting = new DeviceRefusedError('resetting');
    expect(resetting).toBeInstanceOf(Error);
    expect(resetting.reason).toBe('resetting');
    expect(resetting.message).toBe(RESETTING_TEXT);
    expect(RESETTING_TEXT).toBe('Resetting your phone…');
    expect(new DeviceRefusedError('superseded').message).toMatch(/try again/i);
  });
});
