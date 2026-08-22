import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ABANDONED_AFTER_MS,
  PRESENCE_WINDOW_MS,
  SF_CALL_TIMEOUT_MS,
  SF_CREATE_TIMEOUT_MS,
  expireAbandonedSessions,
  isSalesforceAuthError,
  nudgeDueRetries,
  processRolloverJob,
  runFollowupTick,
  type WorkerDeps,
} from './followup-worker.js';
import { SalesforceUnauthorizedError } from './client.js';
import type { FollowupRolloverJob } from '../db/schema.js';

const NOW = new Date('2026-08-22T17:00:00Z');
const openTask = { Id: '00T1', Subject: 'Follow-up', Type: 'Call', Priority: 'Normal', OwnerId: '005', WhoId: '00Q1', WhatId: null, ActivityDate: '2026-08-20' };

function fakeDb() {
  const writes: Array<{ patch: Record<string, unknown> }> = [];
  return {
    _writes: writes,
    update(_t: unknown) { return { set: (patch: any) => ({ where: async () => { writes.push({ patch }); } }) }; },
  } as any;
}
// `WorkerDeps.db` is typed as the real Drizzle handle (needed by nudgeDueRetries /
// runFollowupTick), so `d.db` loses the fake's `_writes` field statically even
// though `fakeDb()` supplies it at runtime. Narrow back to it here instead of
// casting at every call site.
function writesOf(d: WorkerDeps): Array<{ patch: Record<string, unknown> }> {
  return (d.db as unknown as { _writes: Array<{ patch: Record<string, unknown> }> })._writes;
}
function job(o: Partial<FollowupRolloverJob> = {}): FollowupRolloverJob {
  return {
    id: 'J1', orgId: 'O1', userId: 'U1', sfOwnerId: '005', sessionId: 'S1', recordId: '00Q1', objectType: 'Lead',
    fromDate: '2026-08-20', status: 'in_flight', attempts: 1, lastError: null, nextAttemptAt: new Date(),
    completedAt: null, completedTaskId: null, createdTaskId: null, targetDate: null, sourceTaskId: null, createdAt: new Date(), updatedAt: new Date(),
    ...o,
  } as FollowupRolloverJob;
}
function deps(over: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    db: fakeDb(),
    sf: {
      // One fake answers both queries, dispatching on the query text: the
      // daily-cap fetch (`followUpTasksSoql`) is the only one selecting
      // `FROM Task WHERE OwnerId`; everything else is a task lookup. The cap
      // list has ONE follow-up ('Refund' must not count), i.e. room to spare.
      soqlQuery: vi.fn(async (_u: string, q: string) =>
        (/FROM Task WHERE OwnerId/.test(q) ? [{ Subject: 'FU' }, { Subject: 'Refund' }] : [openTask])) as unknown as WorkerDeps['sf']['soqlQuery'],
      sfFetch: vi.fn(async (_u: string, path: string, init?: any) =>
        init?.method === 'POST' ? { status: 201, json: { id: '00TNEW' } } : { status: 204, json: null }),
    },
    calendarFor: vi.fn(async () => ({ workingWeekdays: new Set([1, 2, 3, 4, 5]), holidays: new Set<string>() })),
    capFor: vi.fn(async () => 100),
    now: () => NOW,
    advance: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    ...over,
  };
}

/** A never-settling promise — what a hung Salesforce socket looks like. */
function hangs<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/**
 * Records writes AND Salesforce calls into one shared `order` array, so a test
 * can assert a DB write happened BEFORE a network call (I10's pre-stamp).
 * `write:` entries carry the patch's sorted key list.
 */
function orderedFakeDb(order: string[]) {
  const writes: Array<{ patch: Record<string, unknown> }> = [];
  return {
    _writes: writes,
    update(_t: unknown) {
      return {
        set: (patch: any) => ({
          where: async () => {
            writes.push({ patch });
            order.push(`write:${Object.keys(patch).sort().join(',')}`);
          },
        }),
      };
    },
  } as any;
}

/** Fake for `nudgeDueRetries`' single `selectDistinct(...).from(...).innerJoin(...).where(...)`. */
function nudgeDb(rows: Array<Record<string, unknown>>) {
  return {
    selectDistinct: () => ({ from: () => ({ innerJoin: () => ({ where: async () => rows }) }) }),
  } as unknown as WorkerDeps['db'];
}

/**
 * Fake for `expireAbandonedSessions`. `sessions` is the candidate list the SQL
 * pre-filter would return (the real status/staleness decision is re-made in JS
 * by `isAbandoned`, which is what these tests exercise). `itemLists` is consumed
 * one entry per queue-item lookup, in the order the loop makes them.
 */
function expireDb(sessions: Array<Record<string, unknown>>, itemLists: Array<Array<Record<string, unknown>>> = []) {
  let call = 0;
  return {
    query: {
      dialerSessions: { findMany: async () => sessions },
      dialerQueueItems: { findMany: async () => itemLists[call++] ?? [] },
    },
  } as unknown as WorkerDeps['db'];
}

const session = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'S1', status: 'active', lastPolledAt: new Date(NOW.getTime() - ABANDONED_AFTER_MS - 1), updatedAt: NOW, ...o,
});

describe('processRolloverJob', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {}); // terminal failures log loudly now
  });

  /** The single write of a given status (patches are pushed in order). */
  function patchWith(d: WorkerDeps, status: string): Record<string, unknown> {
    const w = writesOf(d).find((x) => x.patch.status === status);
    if (!w) throw new Error(`no ${status} write`);
    return w.patch;
  }

  it('creates the copy on the next business day with room, THEN completes the original, and succeeds', async () => {
    const d = deps(); const fetch = d.sf.sfFetch as any;
    await processRolloverJob(job(), d);
    const calls = fetch.mock.calls.map((c: any[]) => [c[1], c[2]?.method]);
    expect(calls[0]).toEqual(['/sobjects/Task', 'POST']);          // create first
    expect(calls[1]).toEqual(['/sobjects/Task/00T1', 'PATCH']);    // then complete
    expect(fetch.mock.calls[0][2].body).toMatchObject({ ActivityDate: '2026-08-21', OwnerId: '005', Status: 'Not Started' });
    // I10: the day fields are pre-stamped before the POST; createdTaskId lands alone after it.
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ targetDate: '2026-08-21', nextDay: '2026-08-21', completedTaskId: '00T1' }) });
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ createdTaskId: '00TNEW' }) });
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ status: 'succeeded', completedTaskId: '00T1' }) });
  });

  it('pushes to a later day when the next business day is at the cap', async () => {
    const full = Array.from({ length: 100 }, () => ({ Subject: 'Follow-up' }));
    const d = deps({ sf: { ...deps().sf, soqlQuery: vi.fn(async (_u: string, q: string) =>
      (/FROM Task WHERE OwnerId/.test(q) ? (q.includes('2026-08-21') ? full : [{ Subject: 'Follow-up' }]) : [openTask])) as unknown as WorkerDeps['sf']['soqlQuery'] } });
    await processRolloverJob(job(), d);
    expect((d.sf.sfFetch as any).mock.calls[0][2].body.ActivityDate).toBe('2026-08-24');
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ targetDate: '2026-08-24', nextDay: '2026-08-21' }) });
  });

  it('is idempotent on retry: a job that already created its copy only completes (no second create)', async () => {
    const d = deps(); const fetch = d.sf.sfFetch as any;
    await processRolloverJob(job({ createdTaskId: '00TNEW', completedTaskId: '00T1', targetDate: '2026-08-21', attempts: 2 }), d);
    expect(fetch.mock.calls.map((c: any[]) => c[2]?.method)).toEqual(['PATCH']);
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ status: 'succeeded' }) });
  });

  it('succeeds as no-task (creates nothing) when the rep has no open follow-up on the record', async () => {
    const d = deps({ sf: { ...deps().sf, soqlQuery: vi.fn(async () => []) } });
    await processRolloverJob(job(), d);
    expect(d.sf.sfFetch).not.toHaveBeenCalled();
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ status: 'succeeded', lastError: 'no-task' }) });
  });

  it('rolls the SOURCE task by id on a Task-run job (no search), and no-ops if it is closed/reassigned', async () => {
    const d = deps({ sf: { ...deps().sf, soqlQuery: vi.fn(async (_u: string, q: string) =>
      (/Id = '00T9'/.test(q) ? [{ ...openTask, Id: '00T9' }] : [])) as unknown as WorkerDeps['sf']['soqlQuery'] } });
    await processRolloverJob(job({ sourceTaskId: '00T9' }), d);
    expect((d.sf.sfFetch as any).mock.calls.map((c: any[]) => c[1])).toEqual(['/sobjects/Task', '/sobjects/Task/00T9']);
    // ...and the record was never searched for a follow-up (that is the point of
    // carrying the id: the record may hold several, only one of which was dialed).
    expect((d.sf.soqlQuery as any).mock.calls.map((c: any[]) => c[1]).filter((q: string) => /WhoId =/.test(q))).toEqual([]);
    // Closed, completed by hand, or reassigned since the miss: the by-id lookup
    // finds nothing and the job closes out as no-task rather than searching the
    // record (which could roll a DIFFERENT follow-up the rep never dialed).
    const d2 = deps({ sf: { ...deps().sf, soqlQuery: vi.fn(async () => []) as unknown as WorkerDeps['sf']['soqlQuery'] } });
    await processRolloverJob(job({ sourceTaskId: '00T9' }), d2);
    expect(d2.sf.sfFetch).not.toHaveBeenCalled();
    expect(writesOf(d2)).toContainEqual({ patch: expect.objectContaining({ status: 'succeeded', lastError: 'no-task' }) });
  });

  /** 8/21 holds one follow-up and one decoy ('Refund' — a bare-substring 'FU'
   *  the shared rule must NOT count); every other day is empty. `seen` collects
   *  the cap queries. */
  const capDayFake = (seen: string[] = []) => vi.fn(async (_u: string, q: string) => {
    if (/FROM Task WHERE OwnerId/.test(q)) { seen.push(q); return /2026-08-21/.test(q) ? [{ Subject: 'F/U' }, { Subject: 'Refund' }] : []; }
    return [openTask];
  }) as unknown as WorkerDeps['sf']['soqlQuery'];

  it('counts the day\'s follow-ups in code with the shared subject rule (FU counts, Refund does not)', async () => {
    const seen: string[] = [];
    const d = deps({ capFor: vi.fn(async () => 1), sf: { ...deps().sf, soqlQuery: capDayFake(seen) } });
    await processRolloverJob(job(), d);
    expect(seen[0]).toMatch(/^SELECT Id, Subject FROM Task WHERE /); // fetched and counted here, not SELECT COUNT() in SOQL
    expect((d.sf.sfFetch as any).mock.calls[0][2].body.ActivityDate).toBe('2026-08-24'); // 8/21 had 1 FU = at cap 1 → pushed
  });

  it('a non-follow-up on the day does not eat a slot in the cap', async () => {
    // Same day and same two tasks at cap 2: by the shared rule that day holds
    // ONE follow-up, so the copy still lands on 8/21. Counting rows (2) — what a
    // subject-blind COUNT() would do — would push it to 8/24.
    const d = deps({ capFor: vi.fn(async () => 2), sf: { ...deps().sf, soqlQuery: capDayFake() } });
    await processRolloverJob(job(), d);
    expect((d.sf.sfFetch as any).mock.calls[0][2].body.ActivityDate).toBe('2026-08-21');
  });

  it('fails immediately (no retry) on a Salesforce auth error', async () => {
    const d = deps({ sf: { ...deps().sf, soqlQuery: vi.fn(async () => { throw new SalesforceUnauthorizedError(); }) } });
    await processRolloverJob(job(), d);
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ status: 'failed', lastError: 'reconnect Salesforce' }) });
  });

  it('backs off and retries on a transient error, failing for good after 8 attempts', async () => {
    const boom = vi.fn(async () => { throw new Error('503'); });
    const d = deps({ sf: { ...deps().sf, soqlQuery: boom } });
    await processRolloverJob(job({ attempts: 1 }), d);
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ status: 'pending', lastError: '503' }) });
    expect((patchWith(d, 'pending').nextAttemptAt as Date).getTime() - NOW.getTime()).toBe(30_000);
    const d3 = deps({ sf: { ...deps().sf, soqlQuery: boom } });
    await processRolloverJob(job({ attempts: 3 }), d3);
    expect((patchWith(d3, 'pending').nextAttemptAt as Date).getTime() - NOW.getTime()).toBe(120_000);
    const d2 = deps({ sf: { ...deps().sf, soqlQuery: boom } });
    await processRolloverJob(job({ attempts: 8 }), d2);
    expect(writesOf(d2)).toContainEqual({ patch: expect.objectContaining({ status: 'failed' }) });
  });

  it('fails loudly when no business day within the bound has room', async () => {
    const full = Array.from({ length: 100 }, () => ({ Subject: 'Follow-up' })); // every day is at the cap
    const d = deps({ sf: { ...deps().sf, soqlQuery: vi.fn(async (_u: string, q: string) =>
      (/FROM Task WHERE OwnerId/.test(q) ? full : [openTask])) as unknown as WorkerDeps['sf']['soqlQuery'] } });
    await processRolloverJob(job(), d);
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ status: 'failed', lastError: expect.stringMatching(/no business day with room/) }) });
  });

  it('treats a failed token refresh (a revoked connection) as terminal auth, not a transient retry', async () => {
    const revoked = vi.fn(async () => { throw new Error('Salesforce token refresh failed (400): {"error":"invalid_grant"}'); });
    const d = deps({ sf: { ...deps().sf, soqlQuery: revoked } });
    await processRolloverJob(job({ attempts: 1 }), d);
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ status: 'failed', lastError: 'reconnect Salesforce' }) });
  });

  it('stamps the source task at create time and, on retry, completes THAT task without re-resolving', async () => {
    const d = deps(); const fetch = d.sf.sfFetch as any;
    await processRolloverJob(job({ createdTaskId: '00TNEW', completedTaskId: '00T1', targetDate: '2026-08-21', attempts: 2 }), d);
    expect(d.sf.soqlQuery).not.toHaveBeenCalled(); // never re-resolves — it could pick the COPY
    expect(fetch.mock.calls.map((c: any[]) => [c[1], c[2]?.method])).toEqual([['/sobjects/Task/00T1', 'PATCH']]);
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ status: 'succeeded', completedTaskId: '00T1' }) });
  });

  it('stamps completedTaskId (the SOURCE task) alongside the target day, so the retry path knows what to complete', async () => {
    const d = deps();
    await processRolloverJob(job(), d);
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ completedTaskId: '00T1', targetDate: '2026-08-21', nextDay: '2026-08-21' }) });
  });

  it('pre-stamps the target day and source task BEFORE the create POST (I10)', async () => {
    const order: string[] = [];
    const base = deps();
    const d = deps({
      db: orderedFakeDb(order),
      sf: {
        ...base.sf,
        sfFetch: vi.fn(async (_u: string, _path: string, init?: any) => {
          order.push(init?.method === 'POST' ? 'POST' : 'PATCH');
          return init?.method === 'POST' ? { status: 201, json: { id: '00TNEW' } } : { status: 204, json: null };
        }) as any,
      },
    });
    await processRolloverJob(job(), d);
    const preStamp = order.indexOf('write:completedTaskId,nextDay,targetDate,updatedAt');
    const post = order.indexOf('POST');
    expect(preStamp).toBeGreaterThanOrEqual(0);
    expect(post).toBeGreaterThanOrEqual(0);
    expect(preStamp).toBeLessThan(post);
    // createdTaskId is stamped alone, and only once the id is known.
    expect(order.indexOf('write:createdTaskId,updatedAt')).toBeGreaterThan(post);
  });

  it('a create that never answers times out, backs off, and still leaves the day fields stamped (I10 / T5)', async () => {
    vi.useFakeTimers();
    try {
      const base = deps();
      const d = deps({
        sf: {
          ...base.sf,
          sfFetch: vi.fn((_u: string, _path: string, init?: any) =>
            init?.method === 'POST' ? hangs<any>() : Promise.resolve({ status: 204, json: null })) as any,
        },
      });
      const p = processRolloverJob(job({ attempts: 1 }), d);
      await vi.advanceTimersByTimeAsync(0); // let the pre-create awaits settle
      await vi.advanceTimersByTimeAsync(SF_CREATE_TIMEOUT_MS + 1);
      await p;
      expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ targetDate: '2026-08-21', completedTaskId: '00T1' }) });
      expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ status: 'pending', lastError: expect.stringMatching(/create task timed out/) }) });
      expect(writesOf(d).some((w) => 'createdTaskId' in w.patch)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a business-calendar fetch that never answers times out instead of pinning the tick (I5)', async () => {
    vi.useFakeTimers();
    try {
      const d = deps({ calendarFor: vi.fn(() => hangs<any>()) as any });
      const p = processRolloverJob(job({ attempts: 1 }), d);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(SF_CALL_TIMEOUT_MS + 1);
      await p;
      expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({
        status: 'pending', lastError: expect.stringMatching(/business calendar timed out/),
      }) });
      expect(d.sf.sfFetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off (never PATCHes Task/null) when createdTaskId is stamped but completedTaskId is not (I9)', async () => {
    const d = deps();
    await processRolloverJob(job({ createdTaskId: '00TNEW', completedTaskId: null, attempts: 1 }), d);
    expect(d.sf.sfFetch).not.toHaveBeenCalled();
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({
      status: 'pending', lastError: 'job has createdTaskId but no completedTaskId',
    }) });
  });

  it('an auth error AFTER the copy exists is retried, not failed (I8)', async () => {
    // Create succeeds, the complete PATCH comes back 401. Failing here would
    // leave the copy on tomorrow's list AND the original open — a duplicate the
    // rep sees forever. Retrying finishes the job once they reconnect.
    const base = deps();
    const d = deps({
      sf: {
        ...base.sf,
        sfFetch: vi.fn(async (_u: string, _path: string, init?: any) =>
          init?.method === 'POST'
            ? { status: 201, json: { id: '00TNEW' } }
            : { status: 401, json: [{ errorCode: 'INVALID_SESSION_ID' }] }) as any,
      },
    });
    await processRolloverJob(job({ attempts: 1 }), d);
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({
      status: 'pending', lastError: 'reconnect Salesforce (copy exists; will retry completing the original)',
    }) });
    expect(writesOf(d).some((w) => w.patch.status === 'failed')).toBe(false);
  });

  it('an auth error on the retry path (copy already created) is also retried (I8)', async () => {
    const base = deps();
    const d = deps({ sf: { ...base.sf, sfFetch: vi.fn(async () => ({ status: 401, json: [{ errorCode: 'INVALID_SESSION_ID' }] })) as any } });
    await processRolloverJob(job({ createdTaskId: '00TNEW', completedTaskId: '00T1', attempts: 2 }), d);
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({
      status: 'pending', lastError: 'reconnect Salesforce (copy exists; will retry completing the original)',
    }) });
  });

  it('an auth error BEFORE the create stays terminal (I8)', async () => {
    const base = deps();
    const d = deps({ sf: { ...base.sf, sfFetch: vi.fn(async () => ({ status: 401, json: [{ errorCode: 'INVALID_SESSION_ID' }] })) as any } });
    await processRolloverJob(job({ attempts: 1 }), d);
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ status: 'failed', lastError: 'reconnect Salesforce' }) });
  });

  it('logs every terminal failure loudly (M5)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps({ sf: { ...deps().sf, soqlQuery: vi.fn(async () => { throw new SalesforceUnauthorizedError(); }) } });
    await processRolloverJob(job(), d);
    expect(spy).toHaveBeenCalledWith('[followup-worker] job failed', expect.objectContaining({
      jobId: 'J1', userId: 'U1', recordId: '00Q1', reason: 'reconnect Salesforce',
    }));
  });

  it('a job pre-stamped before the create (crash between stamp and POST) still CREATES on retry — the retry keys on createdTaskId only', async () => {
    const d = deps(); const fetch = d.sf.sfFetch as any;
    await processRolloverJob(job({ createdTaskId: null, targetDate: '2026-08-21', nextDay: '2026-08-21', completedTaskId: '00T1', attempts: 2 }), d);
    const methods = fetch.mock.calls.map((c: any[]) => [c[1], c[2]?.method]);
    expect(methods).toContainEqual(['/sobjects/Task', 'POST']);              // the copy IS created
    expect(methods.findIndex((m: any[]) => m[1] === 'POST')).toBeLessThan(methods.findIndex((m: any[]) => m[1] === 'PATCH')); // and before the complete
  });

  it('treats a 201 whose body carries no id as transient, stamping no createdTaskId (L3)', async () => {
    const base = deps();
    const d = deps({
      sf: {
        ...base.sf,
        sfFetch: vi.fn(async (_u: string, _path: string, init?: any) =>
          init?.method === 'POST' ? { status: 201, json: {} } : { status: 204, json: null }) as any,
      },
    });
    await processRolloverJob(job({ attempts: 1 }), d);
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({
      status: 'pending', lastError: expect.stringMatching(/create returned no id/),
    }) });
    expect(writesOf(d).some((w) => 'createdTaskId' in w.patch)).toBe(false);
  });
});

describe('isSalesforceAuthError', () => {
  it('is true for every shape that means "reconnect Salesforce"', () => {
    expect(isSalesforceAuthError(new SalesforceUnauthorizedError())).toBe(true);
    expect(isSalesforceAuthError(new Error('Salesforce token refresh failed (400): {"error":"invalid_grant"}'))).toBe(true);
    expect(isSalesforceAuthError(new Error('complete failed (401): [{"errorCode":"INVALID_SESSION_ID"}]'))).toBe(true);
  });

  it('is false for transient failures that retrying can fix', () => {
    expect(isSalesforceAuthError(new Error('create failed (503): {"message":"server busy"}'))).toBe(false);
    expect(isSalesforceAuthError(new Error('ECONNRESET'))).toBe(false);
  });
});

describe('runFollowupTick', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  /** Fake handle for the tick: `.where()` is awaitable (reaper / patchJob) AND
   *  carries `.returning()` (the conditional claim). `claimReturns` is what the
   *  claim sees — `[]` means another replica got the row first. */
  function tickDb(jobs: FollowupRolloverJob[], claimReturns: Array<{ id: string }>, throwOnStatus?: string) {
    const writes: Array<{ patch: Record<string, unknown> }> = [];
    return {
      _writes: writes,
      update: (_t: unknown) => ({
        set: (patch: Record<string, unknown>) => ({
          where: (_w: unknown) => {
            writes.push({ patch });
            const done = (throwOnStatus && patch.status === throwOnStatus
              ? Promise.reject(new Error('db write exploded'))
              : Promise.resolve([])) as Promise<unknown> & { returning: () => Promise<Array<{ id: string }>> };
            done.returning = async () => claimReturns;
            return done;
          },
        }),
      }),
      query: { followupRolloverJobs: { findMany: async () => jobs } },
    } as unknown as WorkerDeps['db'];
  }

  it('skips a job whose conditional pending → in_flight claim lost to another replica', async () => {
    const d = deps({ db: tickDb([job({ status: 'pending' })], []) });
    const out = await runFollowupTick(d);
    expect(out.processed).toBe(0);
    // processRolloverJob never ran: no Salesforce work at all for the lost row.
    expect(d.sf.soqlQuery).not.toHaveBeenCalled();
    expect(d.sf.sfFetch).not.toHaveBeenCalled();
  });

  it('processes the job when the claim wins the row', async () => {
    const d = deps({ db: tickDb([job({ status: 'pending' })], [{ id: 'J1' }]) });
    const out = await runFollowupTick(d);
    expect(out.processed).toBe(1);
    expect(d.sf.soqlQuery).toHaveBeenCalled();
  });

  it('stamps each claim with a fresh clock read, not the tick start (C2)', async () => {
    // The reaper measures staleness from `updated_at`. A 25-job batch can take
    // minutes to drain, so stamping every claim with the tick's start time made
    // the last jobs look minutes-stale the moment they were claimed — instantly
    // reap-eligible on another replica, and therefore run twice.
    let t = NOW.getTime();
    const d = deps({
      db: tickDb([job({ id: 'J1', status: 'pending' }), job({ id: 'J2', status: 'pending' })], [{ id: 'claimed' }]),
      now: () => new Date((t += 60_000)),
    });
    await runFollowupTick(d);
    const claimedAt = writesOf(d)
      .filter((w) => w.patch.status === 'in_flight')
      .map((w) => (w.patch.updatedAt as Date).getTime());
    expect(claimedAt).toHaveLength(2);
    const [first = 0, second = 0] = claimedAt;
    expect(second).toBeGreaterThan(first);
  });

  it('keeps draining the batch when one job throws out of processRolloverJob', async () => {
    // J1 is out of attempts, so its terminal 'failed' write runs — and that write
    // explodes, throwing straight out of processRolloverJob. J2 must still run.
    const d = deps({
      db: tickDb([job({ id: 'J1', status: 'pending', attempts: 8 }), job({ id: 'J2', status: 'pending' })], [{ id: 'J1' }], 'failed'),
      sf: { ...deps().sf, soqlQuery: vi.fn(async () => { throw new Error('boom'); }) },
    });
    const out = await runFollowupTick(d);
    expect(out.processed).toBe(2);
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ status: 'pending', lastError: 'boom' }) }); // J2's backoff
  });
});

describe('nudgeDueRetries — the presence gate on originating a call', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  const row = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
    sessionId: 'S1', status: 'active', lastPolledAt: new Date(NOW.getTime() - 2_000), retryNotBefore: new Date(NOW.getTime() - 1_000), ...o,
  });

  it('advances an active session whose floor has passed and whose softphone just polled', async () => {
    const d = deps({ db: nudgeDb([row()]) });
    expect(await nudgeDueRetries(d)).toBe(1);
    expect(d.advance).toHaveBeenCalledWith('S1');
  });

  it('skips a session that has never been polled — no evidence a rep is there', async () => {
    const d = deps({ db: nudgeDb([row({ lastPolledAt: null })]) });
    expect(await nudgeDueRetries(d)).toBe(0);
    expect(d.advance).not.toHaveBeenCalled();
  });

  it('skips a stale poll — a 20s-old poll is ten missed polls, i.e. a closed tab (I4)', async () => {
    expect(PRESENCE_WINDOW_MS).toBe(10_000);
    const d = deps({ db: nudgeDb([row({ lastPolledAt: new Date(NOW.getTime() - 20_000) })]) });
    expect(await nudgeDueRetries(d)).toBe(0);
    expect(d.advance).not.toHaveBeenCalled();
  });

  it('skips a paused session', async () => {
    const d = deps({ db: nudgeDb([row({ status: 'paused' })]) });
    expect(await nudgeDueRetries(d)).toBe(0);
    expect(d.advance).not.toHaveBeenCalled();
  });

  it('skips a retry whose floor is still in the future', async () => {
    const d = deps({ db: nudgeDb([row({ retryNotBefore: new Date(NOW.getTime() + 60_000) })]) });
    expect(await nudgeDueRetries(d)).toBe(0);
    expect(d.advance).not.toHaveBeenCalled();
  });

  it('one rep\'s failing advance does not stop the other reps being nudged', async () => {
    const advance = vi.fn(async (id: string) => { if (id === 'S1') throw new Error('twilio down'); });
    const d = deps({ db: nudgeDb([row({ sessionId: 'S1' }), row({ sessionId: 'S2' })]), advance });
    await nudgeDueRetries(d);
    expect(advance).toHaveBeenCalledWith('S2');
  });
});

describe('expireAbandonedSessions — free the one-active-session slot (C1)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('stops an active run whose softphone stopped polling and which has nothing in flight', async () => {
    const d = deps({ db: expireDb([session()], [[{ status: 'no_connect' }, { status: 'pending' }]]) });
    expect(await expireAbandonedSessions(d)).toBe(1);
    expect(d.stop).toHaveBeenCalledWith('S1');
  });

  it('never touches a run with a live dial, however stale the poll — the call IS the presence', async () => {
    const d = deps({ db: expireDb([session()], [[{ status: 'dialing' }]]) });
    expect(await expireAbandonedSessions(d)).toBe(0);
    expect(d.stop).not.toHaveBeenCalled();
  });

  it('never touches a run with a connected call', async () => {
    const d = deps({ db: expireDb([session()], [[{ status: 'connected' }]]) });
    expect(await expireAbandonedSessions(d)).toBe(0);
    expect(d.stop).not.toHaveBeenCalled();
  });

  it('leaves a freshly polled run alone', async () => {
    const d = deps({ db: expireDb([session({ lastPolledAt: new Date(NOW.getTime() - 1_000) })], [[]]) });
    expect(await expireAbandonedSessions(d)).toBe(0);
    expect(d.stop).not.toHaveBeenCalled();
  });

  it('leaves paused and done runs alone — they do not hold the active slot', async () => {
    const d = deps({ db: expireDb([session({ status: 'paused' }), session({ id: 'S2', status: 'done' })], [[], []]) });
    expect(await expireAbandonedSessions(d)).toBe(0);
    expect(d.stop).not.toHaveBeenCalled();
  });

  it('expires a run that was never polled at all, falling back to updated_at', async () => {
    const d = deps({
      db: expireDb([session({ lastPolledAt: null, updatedAt: new Date(NOW.getTime() - ABANDONED_AFTER_MS - 1) })], [[]]),
    });
    expect(await expireAbandonedSessions(d)).toBe(1);
    expect(d.stop).toHaveBeenCalledWith('S1');
  });

  it('never originates a call', async () => {
    const d = deps({ db: expireDb([session()], [[]]) });
    await expireAbandonedSessions(d);
    expect(d.advance).not.toHaveBeenCalled();
  });

  it('one rep\'s failing stop does not block the rest of the sweep', async () => {
    const stop = vi.fn(async (id: string) => { if (id === 'S1') throw new Error('twilio down'); });
    const d = deps({ db: expireDb([session({ id: 'S1' }), session({ id: 'S2' })], [[], []]), stop });
    expect(await expireAbandonedSessions(d)).toBe(1);
    expect(stop).toHaveBeenCalledWith('S2');
  });
});
