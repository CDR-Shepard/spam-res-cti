import { afterEach, describe, expect, it, vi } from 'vitest';
import { SalesforceUnauthorizedError } from './client.js';
import type { DialerTimeStore } from './dialer-time-store.js';
import type { SyncedRow, WindowLeg } from './dialer-time-plan.js';
import { DIALER_TIME_INTERVAL_MS, maybeStartDialerTimeLoop, runDialerTimeTick, type DialerTimeDeps } from './dialer-time-worker.js';

const NOW = new Date('2026-10-02T17:00:00Z'); // 10:00 PDT
const MIN = 60_000;
// 09:00-09:30 PDT → 1800 s on 2026-10-02
const LEG: WindowLeg = { orgId: 'org1', userId: 'g', joinedAt: new Date('2026-10-02T16:00:00Z'), endedAt: new Date('2026-10-02T16:30:00Z') };

function memoryStore(init: { legs?: WindowLeg[]; rows?: SyncedRow[]; sfUserId?: string | null } = {}) {
  const rows = new Map<string, SyncedRow>((init.rows ?? []).map((r) => [r.id, { ...r }]));
  const calls: string[] = [];
  const legWindows: Array<{ start: Date; end: Date }> = [];
  const store: DialerTimeStore & {
    rows: Map<string, SyncedRow>;
    failures: Array<{ id: string; attempts: number; next: Date; err: string }>;
    legWindows: Array<{ start: Date; end: Date }>;
  } = {
    rows,
    failures: [],
    legWindows,
    loadLegs: async (start, end) => {
      legWindows.push({ start, end });
      return init.legs ?? [LEG];
    },
    loadRows: async (days) => [...rows.values()].filter((r) => days.includes(r.day)),
    async ensureRow(orgId, userId, day) {
      calls.push(`ensure ${userId} ${day}`);
      const found = [...rows.values()].find((r) => r.userId === userId && r.day === day);
      if (found) return found;
      const r: SyncedRow = { id: `row-${userId}-${day}`, orgId, userId, day, salesforceTaskId: null, syncedSeconds: null, attempts: 0, nextAttemptAt: new Date(0) };
      rows.set(r.id, r);
      return r;
    },
    async claimRow(id, now, leaseMs) {
      const r = rows.get(id);
      if (!r || r.nextAttemptAt.getTime() > now.getTime()) return null;
      // No await between the check and the set: this is the whole point of
      // the in-memory store standing in for an atomic `UPDATE ... RETURNING`.
      const claimed = { ...r, nextAttemptAt: new Date(now.getTime() + leaseMs) };
      rows.set(id, claimed);
      return claimed;
    },
    async saveSynced(id, taskId, seconds, now) {
      const r = rows.get(id)!;
      rows.set(id, { ...r, salesforceTaskId: taskId, syncedSeconds: seconds, attempts: 0, nextAttemptAt: now });
    },
    async saveFailure(id, attempts, next, err) {
      store.failures.push({ id, attempts, next, err });
      const r = rows.get(id)!;
      rows.set(id, { ...r, attempts, nextAttemptAt: next });
    },
    async clearTaskId(id, now) {
      const r = rows.get(id)!;
      // Also releases the claim (I1): due again immediately, not after the lease.
      rows.set(id, { ...r, salesforceTaskId: null, syncedSeconds: null, nextAttemptAt: now ?? r.nextAttemptAt });
    },
    sfUserIdFor: async () => (init.sfUserId === undefined ? '005G' : init.sfUserId),
  };
  return { store, calls };
}

function deps(store: DialerTimeStore, sf: Partial<DialerTimeDeps['sf']> = {}, now: () => Date = () => NOW): DialerTimeDeps {
  return {
    store,
    now,
    sf: {
      createDialerTimeTask: vi.fn(async () => ({ taskId: '00TNEW' })),
      updateDialerTimeTask: vi.fn(async () => 'updated' as const),
      findDialerTimeTask: vi.fn(async () => null),
      ...sf,
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('runDialerTimeTick', () => {
  it('creates the day\'s Task as the rep and stamps its id and seconds', async () => {
    const { store } = memoryStore();
    const d = deps(store);
    await expect(runDialerTimeTick(d)).resolves.toEqual({ planned: 1, written: 1 });
    expect(d.sf.findDialerTimeTask).toHaveBeenCalledWith('g', '005G', '2026-10-02');
    expect(d.sf.createDialerTimeTask).toHaveBeenCalledWith('g', '2026-10-02', 1800);
    expect(store.rows.get('row-g-2026-10-02')).toMatchObject({ salesforceTaskId: '00TNEW', syncedSeconds: 1800 });
  });

  it('two overlapping instances racing the same shared store create exactly one Task (I1)', async () => {
    // Simulates two API instances (old + new container during a deploy) both
    // ticking at once. The Salesforce create is held open until both ticks
    // have had a chance to claim the row, so this only passes if claimRow's
    // check-and-set is atomic: whichever tick claims first wins, and the
    // other must see the lease and bail out WITHOUT calling createDialerTimeTask.
    const { store } = memoryStore();
    let resolveCreate!: (v: { taskId: string }) => void;
    const createPromise = new Promise<{ taskId: string }>((resolve) => {
      resolveCreate = resolve;
    });
    const sf: DialerTimeDeps['sf'] = {
      createDialerTimeTask: vi.fn(() => createPromise),
      updateDialerTimeTask: vi.fn(async () => 'updated' as const),
      findDialerTimeTask: vi.fn(async () => null),
    };
    const d1: DialerTimeDeps = { store, now: () => NOW, sf };
    const d2: DialerTimeDeps = { store, now: () => NOW, sf };

    const p1 = runDialerTimeTick(d1);
    const p2 = runDialerTimeTick(d2);
    // p2 never reaches the (still-blocked) Salesforce create: its claim loses
    // the race, so it settles on its own without waiting on createPromise.
    const r2 = await p2;
    resolveCreate({ taskId: '00T1' });
    const r1 = await p1;

    expect(sf.createDialerTimeTask).toHaveBeenCalledTimes(1);
    expect(r1.written + r2.written).toBe(1);
    expect(store.rows.get('row-g-2026-10-02')).toMatchObject({ salesforceTaskId: '00T1', syncedSeconds: 1800 });
  });

  it('adopts a Task already in Salesforce instead of creating a second one', async () => {
    const { store } = memoryStore();
    const d = deps(store, { findDialerTimeTask: vi.fn(async () => '00TOLD') });
    await runDialerTimeTick(d);
    expect(d.sf.createDialerTimeTask).not.toHaveBeenCalled();
    expect(d.sf.updateDialerTimeTask).toHaveBeenCalledWith('g', '00TOLD', 1800);
    expect(store.rows.get('row-g-2026-10-02')).toMatchObject({ salesforceTaskId: '00TOLD', syncedSeconds: 1800 });
  });

  it('creates a new Task when the adopted one is missing from Salesforce', async () => {
    const { store } = memoryStore();
    const d = deps(store, {
      findDialerTimeTask: vi.fn(async () => '00TOLD'),
      updateDialerTimeTask: vi.fn(async () => 'missing' as const),
    });
    await runDialerTimeTick(d);
    expect(d.sf.updateDialerTimeTask).toHaveBeenCalledWith('g', '00TOLD', 1800);
    expect(d.sf.createDialerTimeTask).toHaveBeenCalledWith('g', '2026-10-02', 1800);
    expect(store.rows.get('row-g-2026-10-02')).toMatchObject({ salesforceTaskId: '00TNEW', syncedSeconds: 1800 });
  });

  it('PATCHes the known Task when the seconds changed, and does nothing when they did not', async () => {
    const r: SyncedRow = { id: 'r1', orgId: 'org1', userId: 'g', day: '2026-10-02', salesforceTaskId: '00TX', syncedSeconds: 1200, attempts: 0, nextAttemptAt: new Date(0) };
    const { store } = memoryStore({ rows: [r] });
    const d = deps(store);
    await runDialerTimeTick(d);
    expect(d.sf.updateDialerTimeTask).toHaveBeenCalledWith('g', '00TX', 1800);
    expect(d.sf.findDialerTimeTask).not.toHaveBeenCalled();
    expect(store.rows.get('r1')?.syncedSeconds).toBe(1800);
    await expect(runDialerTimeTick(d)).resolves.toEqual({ planned: 0, written: 0 });
  });

  it('clears the id when Salesforce says the Task is gone, and recreates it next tick', async () => {
    const r: SyncedRow = { id: 'r1', orgId: 'org1', userId: 'g', day: '2026-10-02', salesforceTaskId: '00TGONE', syncedSeconds: 1200, attempts: 0, nextAttemptAt: new Date(0) };
    const { store } = memoryStore({ rows: [r] });
    const d = deps(store, { updateDialerTimeTask: vi.fn(async () => 'missing' as const) });
    await runDialerTimeTick(d);
    expect(store.rows.get('r1')).toMatchObject({ salesforceTaskId: null, syncedSeconds: null });
    await runDialerTimeTick(d);
    expect(d.sf.createDialerTimeTask).toHaveBeenCalledWith('g', '2026-10-02', 1800);
  });

  it('any other error backs off with the full text in last_error only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = memoryStore();
    const body = [{ message: 'Subject: (619) 555-9999', errorCode: 'STRING_TOO_LONG' }];
    const d = deps(store, {
      createDialerTimeTask: vi.fn(async () => {
        throw new Error(`Salesforce Power Dialer Time create failed (400): ${JSON.stringify(body)}`);
      }),
    });
    await runDialerTimeTick(d);
    expect(store.failures).toHaveLength(1);
    expect(store.failures[0]).toMatchObject({ id: 'row-g-2026-10-02', attempts: 1, next: new Date(NOW.getTime() + 5 * MIN) });
    expect(store.failures[0]!.err).toContain('(619) 555-9999');
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('STRING_TOO_LONG');
    expect(logged).not.toContain('555-9999');
  });

  it('an auth error on the create path is skipped uncounted', async () => {
    const { store } = memoryStore();
    const d = deps(store, { createDialerTimeTask: vi.fn(async () => { throw new SalesforceUnauthorizedError(); }) });
    await runDialerTimeTick(d);
    expect(store.failures).toEqual([]);
  });

  it('skips a rep with no Salesforce connection without creating anything', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store } = memoryStore({ sfUserId: null });
    const d = deps(store);
    await runDialerTimeTick(d);
    expect(d.sf.createDialerTimeTask).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).toContain('"userId":"g"');
  });

  it('one rep failing never stops the next rep', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const j: WindowLeg = { ...LEG, userId: 'j' };
    const { store } = memoryStore({ legs: [LEG, j] });
    store.ensureRow = vi.fn(async (orgId, userId, day) => {
      if (userId === 'g') throw new Error('db down');
      const r: SyncedRow = { id: `row-${userId}-${day}`, orgId, userId, day, salesforceTaskId: null, syncedSeconds: null, attempts: 0, nextAttemptAt: new Date(0) };
      store.rows.set(r.id, r); // claimRow reads the row back out of the store
      return r;
    });
    const d = deps(store);
    await runDialerTimeTick(d);
    expect(d.sf.createDialerTimeTask).toHaveBeenCalledWith('j', '2026-10-02', 1800);
  });

  it('loads legs for the 3 Pacific days ending today', async () => {
    const { store } = memoryStore();
    const d = deps(store);
    await runDialerTimeTick(d);
    expect(store.legWindows).toEqual([{ start: new Date('2026-09-30T07:00:00.000Z'), end: new Date('2026-10-03T07:00:00.000Z') }]);
  });

  it('moves the leg window forward just after Pacific midnight', async () => {
    const { store } = memoryStore();
    const afterMidnight = new Date('2026-10-03T07:30:00Z'); // 00:30 PDT Oct 3
    const d = deps(store, {}, () => afterMidnight);
    await runDialerTimeTick(d);
    expect(store.legWindows).toEqual([{ start: new Date('2026-10-01T07:00:00.000Z'), end: new Date('2026-10-04T07:00:00.000Z') }]);
  });
});

describe('maybeStartDialerTimeLoop', () => {
  it('starts on, never off', () => {
    const start = vi.fn(() => ({}) as NodeJS.Timeout);
    expect(maybeStartDialerTimeLoop({ DIALER_TIME_TASKS: 'off' }, start)).toBeNull();
    expect(start).not.toHaveBeenCalled();
    maybeStartDialerTimeLoop({ DIALER_TIME_TASKS: 'on' }, start);
    expect(start).toHaveBeenCalledWith(DIALER_TIME_INTERVAL_MS);
    expect(DIALER_TIME_INTERVAL_MS).toBe(300_000);
  });
});
