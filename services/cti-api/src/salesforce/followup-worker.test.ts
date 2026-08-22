import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processRolloverJob, type WorkerDeps } from './followup-worker.js';
import { SalesforceUnauthorizedError } from './client.js';
import type { FollowupRolloverJob } from '../db/schema.js';

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
    completedAt: null, completedTaskId: null, createdTaskId: null, targetDate: null, createdAt: new Date(), updatedAt: new Date(),
    ...o,
  } as FollowupRolloverJob;
}
function deps(over: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    db: fakeDb(),
    sf: {
      soqlQuery: vi.fn(async () => [openTask]) as unknown as WorkerDeps['sf']['soqlQuery'],
      soqlCount: vi.fn(async () => 10),
      sfFetch: vi.fn(async (_u: string, path: string, init?: any) =>
        init?.method === 'POST' ? { status: 201, json: { id: '00TNEW' } } : { status: 204, json: null }),
    },
    calendarFor: vi.fn(async () => ({ workingWeekdays: new Set([1, 2, 3, 4, 5]), holidays: new Set<string>() })),
    capFor: vi.fn(async () => 100),
    now: () => new Date('2026-08-22T17:00:00Z'),
    ...over,
  };
}

describe('processRolloverJob', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates the copy on the next business day with room, THEN completes the original, and succeeds', async () => {
    const d = deps(); const fetch = d.sf.sfFetch as any;
    await processRolloverJob(job(), d);
    const calls = fetch.mock.calls.map((c: any[]) => [c[1], c[2]?.method]);
    expect(calls[0]).toEqual(['/sobjects/Task', 'POST']);          // create first
    expect(calls[1]).toEqual(['/sobjects/Task/00T1', 'PATCH']);    // then complete
    expect(fetch.mock.calls[0][2].body).toMatchObject({ ActivityDate: '2026-08-21', OwnerId: '005', Status: 'Not Started' });
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ createdTaskId: '00TNEW', targetDate: '2026-08-21' }) });
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ status: 'succeeded', completedTaskId: '00T1' }) });
  });

  it('pushes to a later day when the next business day is at the cap', async () => {
    const d = deps({ sf: { ...deps().sf, soqlCount: vi.fn(async (_u: string, q: string) => (q.includes('2026-08-21') ? 100 : 3)) } });
    await processRolloverJob(job(), d);
    expect((d.sf.sfFetch as any).mock.calls[0][2].body.ActivityDate).toBe('2026-08-24');
  });

  it('is idempotent on retry: a job that already created its copy only completes (no second create)', async () => {
    const d = deps(); const fetch = d.sf.sfFetch as any;
    await processRolloverJob(job({ createdTaskId: '00TNEW', targetDate: '2026-08-21', attempts: 2 }), d);
    expect(fetch.mock.calls.map((c: any[]) => c[2]?.method)).toEqual(['PATCH']);
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ status: 'succeeded' }) });
  });

  it('succeeds as no-task (creates nothing) when the rep has no open follow-up on the record', async () => {
    const d = deps({ sf: { ...deps().sf, soqlQuery: vi.fn(async () => []) } });
    await processRolloverJob(job(), d);
    expect(d.sf.sfFetch).not.toHaveBeenCalled();
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ status: 'succeeded', lastError: 'no-task' }) });
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
    const d2 = deps({ sf: { ...deps().sf, soqlQuery: boom } });
    await processRolloverJob(job({ attempts: 8 }), d2);
    expect(writesOf(d2)).toContainEqual({ patch: expect.objectContaining({ status: 'failed' }) });
  });

  it('fails loudly when no business day within the bound has room', async () => {
    const d = deps({ sf: { ...deps().sf, soqlCount: vi.fn(async () => 999) } });
    await processRolloverJob(job(), d);
    expect(writesOf(d)).toContainEqual({ patch: expect.objectContaining({ status: 'failed', lastError: expect.stringMatching(/no business day with room/) }) });
  });
});
