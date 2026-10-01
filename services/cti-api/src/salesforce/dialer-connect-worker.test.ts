import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema, type DialerConnect } from '@cti/db';
import { SalesforceUnauthorizedError } from './client.js';
import { MAX_TRIES } from './dialer-connect-task.js';
import {
  AUTH_RETRY_MS,
  claimConnectTask,
  expireStaleConnects,
  processConnectTask,
  selectDueConnectTasks,
  type DialerConnectDeps,
} from './dialer-connect-worker.js';

const NOW = new Date('2026-10-01T18:30:00Z');
const LEAD = '00Q000000000001AAA';
const OPP = '006000000000001AAA';
const REP_SF = '005REP000000001';

function connectRow(o: Partial<DialerConnect> = {}): DialerConnect {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    orgId: 'org-1', userId: 'rep-1', sfUserId: REP_SF, sessionId: 'sess-1', itemId: 'item-1',
    callSid: 'CA' + 'a'.repeat(32), objectType: 'Lead', recordId: LEAD,
    fromNumber: '+16195550101', toNumber: '+16195559999',
    bridgedAt: new Date('2026-10-01T18:00:00Z'), endedAt: new Date('2026-10-01T18:02:05Z'), talkSeconds: 125,
    recordingState: 'requested', recordingUrl: null,
    taskState: 'pending', taskAttempts: 1, nextAttemptAt: new Date(NOW.getTime() + 5 * 60_000), lastError: null,
    salesforceTaskId: null, linkAttempts: 0, recordingLinkSyncedAt: null,
    createdAt: new Date('2026-10-01T18:00:00Z'), updatedAt: NOW,
    ...o,
  };
}

function harness(sfOver: Partial<Record<keyof DialerConnectDeps['sf'], unknown>> = {}) {
  const writes: Record<string, unknown>[] = [];
  const db = {
    update: () => ({ set: (patch: Record<string, unknown>) => ({ where: async () => { writes.push(patch); } }) }),
  } as unknown as DialerConnectDeps['db'];
  const sf = {
    createCallTask: vi.fn(async () => ({ taskId: '00TNEW000000001' })),
    updateCallTask: vi.fn(async () => ({ updated: true })),
    fetchOwnership: vi.fn(async (_u: string, id: string) => ({ type: id.startsWith('006') ? 'Opportunity' : 'Lead', ownerId: REP_SF })),
    fetchRecordName: vi.fn(async () => 'Jane Doe'),
    ...sfOver,
  };
  const deps: DialerConnectDeps = {
    db,
    now: () => NOW,
    link: { apiPublicUrl: 'https://api.test', secret: 's'.repeat(32) },
    sf: sf as unknown as DialerConnectDeps['sf'],
  };
  return { deps, writes, sf };
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('processConnectTask — the Task', () => {
  it('a Lead: creates the Task AS THE REP on the Lead (WhoId), then marks it created and due for its link', async () => {
    const h = harness();
    expect(await processConnectTask(connectRow(), h.deps)).toBe('created');
    expect(h.sf.createCallTask).toHaveBeenCalledWith('rep-1', expect.objectContaining({
      subject: 'Outbound Call | Connected | (619) 555-9999 / Jane Doe',
      whoId: LEAD,
      callDisposition: 'Connected',
      callDurationInSeconds: 125,
    }));
    expect(h.writes).toEqual([expect.objectContaining({ taskState: 'created', salesforceTaskId: '00TNEW000000001', lastError: null, nextAttemptAt: NOW })]);
  });

  it('an Opportunity: the Task relates to the Opportunity (WhatId)', async () => {
    const h = harness();
    await processConnectTask(connectRow({ objectType: 'Opportunity', recordId: OPP }), h.deps);
    const input = (h.sf.createCallTask as any).mock.calls[0][1];
    expect(input.whatId).toBe(OPP);
    expect(input.whoId).toBeUndefined();
  });

  it('the click-to-dial owner rule: not the rep\'s record → skipped_not_owner, no Task', async () => {
    const h = harness({ fetchOwnership: vi.fn(async () => ({ type: 'Lead', ownerId: '005SOMEONEELSE1' })) });
    expect(await processConnectTask(connectRow(), h.deps)).toBe('skipped_not_owner');
    expect(h.sf.createCallTask).not.toHaveBeenCalled();
    expect(h.writes).toEqual([expect.objectContaining({ taskState: 'skipped_not_owner' })]);
  });

  it('a record type with no Task link fails the row, logged, no Task', async () => {
    const h = harness();
    expect(await processConnectTask(connectRow({ objectType: 'Task', recordId: '00T1' }), h.deps)).toBe('failed');
    expect(h.sf.createCallTask).not.toHaveBeenCalled();
    expect(h.writes).toEqual([expect.objectContaining({ taskState: 'failed', lastError: 'no Task link for a Task' })]);
  });

  it('a missing name still logs the Task, number-only', async () => {
    const h = harness({ fetchRecordName: vi.fn(async () => null) });
    await processConnectTask(connectRow(), h.deps);
    expect((h.sf.createCallTask as any).mock.calls[0][1].subject).toBe('Outbound Call | Connected | (619) 555-9999');
  });

  it('an auth error is not the row\'s fault: the try is given back and it waits an hour', async () => {
    const h = harness({ createCallTask: vi.fn(async () => { throw new SalesforceUnauthorizedError(); }) });
    expect(await processConnectTask(connectRow({ taskAttempts: 2 }), h.deps)).toBe('retry');
    expect(h.writes).toEqual([expect.objectContaining({
      taskAttempts: 1,
      nextAttemptAt: new Date(NOW.getTime() + AUTH_RETRY_MS),
      lastError: 'reconnect Salesforce',
    })]);
  });

  it('a transient error before the last try keeps the claim\'s backoff and records the error', async () => {
    const h = harness({ createCallTask: vi.fn(async () => { throw new Error('503 busy'); }) });
    expect(await processConnectTask(connectRow({ taskAttempts: 2 }), h.deps)).toBe('retry');
    expect(h.writes).toEqual([expect.objectContaining({ lastError: '503 busy' })]);
    expect(h.writes[0]).not.toHaveProperty('taskState');
    expect(h.writes[0]).not.toHaveProperty('nextAttemptAt');
  });

  it('an error on the last try fails the row, loudly', async () => {
    const h = harness({ createCallTask: vi.fn(async () => { throw new Error('validation rule'); }) });
    expect(await processConnectTask(connectRow({ taskAttempts: MAX_TRIES }), h.deps)).toBe('failed');
    expect(h.writes).toEqual([expect.objectContaining({ taskState: 'failed', lastError: 'validation rule' })]);
    expect(error).toHaveBeenCalledWith('[dialer-connect-worker] gave up — no Task for this power-dial call', expect.objectContaining({ connectId: connectRow().id }));
  });

  it('an ownership lookup that throws fails closed into a retry — never a Task on an unknown owner', async () => {
    const h = harness({ fetchOwnership: vi.fn(async () => { throw new Error('soql 500'); }) });
    expect(await processConnectTask(connectRow(), h.deps)).toBe('retry');
    expect(h.sf.createCallTask).not.toHaveBeenCalled();
  });
});

describe('the Task-phase SQL, rendered', () => {
  const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });

  it('expire: only pending rows bridged more than 24 h ago', () => {
    const { sql, params } = expireStaleConnects(db, NOW).toSQL();
    expect(sql).toContain(`"task_state" = $`);
    expect(sql).toMatch(/"dialer_connects"\."bridged_at" < \$\d+/);
    expect(params).toEqual(expect.arrayContaining(['expired', 'pending', new Date(NOW.getTime() - 24 * 60 * 60_000).toISOString()]));
  });

  it('due: pending, due, inside 24 h, and ended — or bridged 4 h ago with no hang-up heard', () => {
    const { sql, params } = selectDueConnectTasks(db, NOW).toSQL();
    expect(sql).toMatch(/"dialer_connects"\."next_attempt_at" <= \$\d+/);
    expect(sql).toMatch(/"dialer_connects"\."bridged_at" >= \$\d+/);
    expect(sql).toMatch(/\("dialer_connects"\."ended_at" is not null or "dialer_connects"\."bridged_at" <= \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining([
      'pending',
      new Date(NOW.getTime() - 24 * 60 * 60_000).toISOString(),
      new Date(NOW.getTime() - 4 * 60 * 60_000).toISOString(),
    ]));
  });

  it('claim: a compare-and-swap on the attempt count that bumps it and takes the lease', () => {
    const { sql, params } = claimConnectTask(db, { id: 'conn-1', taskAttempts: 2 }, NOW).toSQL();
    expect(sql).toMatch(/"task_attempts" = \$\d+/);
    expect(sql).toMatch(/"dialer_connects"\."task_attempts" = \$\d+/);
    expect(sql).toContain('returning');
    expect(params).toEqual(expect.arrayContaining([3, new Date(NOW.getTime() + 60 * 60_000).toISOString(), 'conn-1', 2]));
  });
});
