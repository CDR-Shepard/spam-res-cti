import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema, type DialerConnect } from '@cti/db';
import { SalesforceUnauthorizedError } from './client.js';
import { MAX_TRIES } from './dialer-connect-task.js';
import { buildRecordingPublicUrl } from '../telephony/recording-links.js';
import {
  AUTH_RETRY_MS,
  LOOP_INTERVAL_MS,
  RECORDING_URL_FIELD,
  claimConnectTask,
  claimLink,
  expireStaleConnects,
  maybeStartDialerConnectLoop,
  processConnectTask,
  pushConnectLink,
  runDialerConnectTick,
  selectDueConnectTasks,
  selectDueLinks,
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

describe('pushConnectLink — the recording link on the Task', () => {
  const withTask = (o: Partial<DialerConnect> = {}) =>
    connectRow({ taskState: 'created', salesforceTaskId: '00TNEW000000001', recordingUrl: 'https://api.twilio.com/r.mp3', linkAttempts: 1, ...o });

  it('PATCHes the PUBLIC playback URL (never the Twilio media URL) as the rep, then stamps it synced', async () => {
    const h = harness();
    expect(await pushConnectLink(withTask(), h.deps)).toBe('synced');
    expect(h.sf.updateCallTask).toHaveBeenCalledWith('rep-1', '00TNEW000000001', {
      [RECORDING_URL_FIELD]: buildRecordingPublicUrl(withTask().id, h.deps.link),
    });
    expect(RECORDING_URL_FIELD).toBe('tdc_cti__Recording_URL__c');
    expect(h.writes).toEqual([expect.objectContaining({ recordingLinkSyncedAt: NOW, lastError: null })]);
  });

  it('a rejected field (no tdc_cti license) stamps synced WITH a loud log — no retry can fix a license', async () => {
    const h = harness({ updateCallTask: vi.fn(async () => ({ updated: false })) });
    expect(await pushConnectLink(withTask(), h.deps)).toBe('rejected');
    expect(h.writes).toEqual([expect.objectContaining({ recordingLinkSyncedAt: NOW, lastError: 'recording link field rejected' })]);
    expect(error).toHaveBeenCalledWith(
      "[dialer-connect-worker] recording link field rejected — check the rep's tdc_cti package license",
      { connectId: withTask().id, userId: 'rep-1' },
    );
  });

  it('an error before the last try records it and waits for the claim\'s backoff', async () => {
    const h = harness({ updateCallTask: vi.fn(async () => { throw new Error('503'); }) });
    expect(await pushConnectLink(withTask(), h.deps)).toBe('retry');
    expect(h.writes).toEqual([expect.objectContaining({ lastError: '503' })]);
    expect(h.writes[0]).not.toHaveProperty('recordingLinkSyncedAt');
  });

  it('an error on the last try gives up, loudly (the select never offers it again)', async () => {
    const h = harness({ updateCallTask: vi.fn(async () => { throw new Error('503'); }) });
    expect(await pushConnectLink(withTask({ linkAttempts: MAX_TRIES }), h.deps)).toBe('failed');
    expect(error).toHaveBeenCalledWith('[dialer-connect-worker] gave up — recording link not on the Task', expect.objectContaining({ connectId: withTask().id }));
  });
});

describe('the link-phase SQL, rendered', () => {
  const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });
  it('due links: a created Task, a recording, not yet synced, tries left, due', () => {
    const { sql, params } = selectDueLinks(db, NOW).toSQL();
    expect(sql).toContain('"dialer_connects"."salesforce_task_id" is not null');
    expect(sql).toContain('"dialer_connects"."recording_url" is not null');
    expect(sql).toContain('"dialer_connects"."recording_link_synced_at" is null');
    expect(sql).toMatch(/"dialer_connects"\."link_attempts" < \$\d+/);
    expect(params).toEqual(expect.arrayContaining(['created', MAX_TRIES]));
  });
  it('link claim: compare-and-swap on link_attempts, still unsynced', () => {
    const { sql, params } = claimLink(db, { id: 'conn-1', linkAttempts: 0 }, NOW).toSQL();
    expect(sql).toMatch(/"dialer_connects"\."link_attempts" = \$\d+/);
    expect(sql).toContain('"dialer_connects"."recording_link_synced_at" is null');
    expect(params).toEqual(expect.arrayContaining([1, 'conn-1', 0]));
  });
});

/**
 * A db fake for the tick: `select…limit()` answers from `selects` in order;
 * `update…where()` is awaitable (a plain write) and has `.returning()`, which
 * answers from `returns` in order: the expire, then each claim.
 */
function tickDb(selects: DialerConnect[][], returns: unknown[][]) {
  const writes: Record<string, unknown>[] = [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => selects.shift() ?? [] }) }) }) }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          writes.push(patch);
          const done = Promise.resolve(undefined) as Promise<undefined> & { returning: () => Promise<unknown[]> };
          done.returning = async () => returns.shift() ?? [];
          return done;
        },
      }),
    }),
  } as unknown as DialerConnectDeps['db'];
  return { db, writes };
}

describe('runDialerConnectTick', () => {
  it('expires, then makes the Task for each row it wins, then attaches each due link', async () => {
    const due = connectRow({ taskAttempts: 0 });
    const claimed = connectRow({ taskAttempts: 1 });
    const linkDue = connectRow({ id: '22222222-2222-4333-8444-555555555555', taskState: 'created', salesforceTaskId: '00TOLD', recordingUrl: 'https://api.twilio.com/r.mp3', linkAttempts: 0 });
    const linkClaimed = { ...linkDue, linkAttempts: 1 };
    const { db } = tickDb([[due], [linkDue]], [[{ id: 'old-1' }], [claimed], [linkClaimed]]);
    const h = harness();
    const result = await runDialerConnectTick({ ...h.deps, db });
    expect(result).toEqual({ expired: 1, tasks: 1, links: 1 });
    expect(h.sf.createCallTask).toHaveBeenCalledTimes(1);
    expect(h.sf.updateCallTask).toHaveBeenCalledWith('rep-1', '00TOLD', expect.any(Object));
    expect(warn).toHaveBeenCalledWith('[dialer-connect-worker] power-dial calls expired without a Task (bridged over 24 h ago)', { count: 1 });
  });

  it('a lost claim (another worker has it) is skipped — no Salesforce call', async () => {
    const { db } = tickDb([[connectRow({ taskAttempts: 0 })], []], [[], []]);
    const h = harness();
    expect(await runDialerConnectTick({ ...h.deps, db })).toEqual({ expired: 0, tasks: 0, links: 0 });
    expect(h.sf.createCallTask).not.toHaveBeenCalled();
  });

  it('a row claimed past its last try (a crash on try 6) fails without another Salesforce call', async () => {
    const past = connectRow({ taskAttempts: MAX_TRIES + 1 });
    const { db, writes } = tickDb([[connectRow({ taskAttempts: MAX_TRIES })], []], [[], [past]]);
    const h = harness();
    await runDialerConnectTick({ ...h.deps, db });
    expect(h.sf.createCallTask).not.toHaveBeenCalled();
    expect(writes).toContainEqual(expect.objectContaining({ taskState: 'failed', lastError: `gave up after ${MAX_TRIES} tries` }));
  });

  it('a failing row does not stop the rest of the batch', async () => {
    const a = connectRow({ id: 'aaaaaaaa-2222-4333-8444-555555555555', taskAttempts: 0 });
    const b = connectRow({ id: 'bbbbbbbb-2222-4333-8444-555555555555', taskAttempts: 0 });
    const { db, writes } = tickDb([[a, b], []], [[], [{ ...a, taskAttempts: 1 }], [{ ...b, taskAttempts: 1 }]]);
    const h = harness({
      createCallTask: vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ taskId: '00TNEW000000002' }),
    });
    const result = await runDialerConnectTick({ ...h.deps, db });
    expect(result.tasks).toBe(2);
    expect(h.sf.createCallTask).toHaveBeenCalledTimes(2);
    expect(writes).toContainEqual(expect.objectContaining({ lastError: 'boom' }));
    expect(writes).toContainEqual(expect.objectContaining({ taskState: 'created', salesforceTaskId: '00TNEW000000002' }));
  });
});

describe('DIALER_CONNECT_TASKS kill switch — the loop', () => {
  it('off never starts the loop', () => {
    const start = vi.fn();
    expect(maybeStartDialerConnectLoop({ DIALER_CONNECT_TASKS: 'off' }, start)).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });
  it('on starts it at the loop interval', () => {
    const timer = {} as NodeJS.Timeout;
    const start = vi.fn(() => timer);
    expect(maybeStartDialerConnectLoop({ DIALER_CONNECT_TASKS: 'on' }, start)).toBe(timer);
    expect(start).toHaveBeenCalledWith(LOOP_INTERVAL_MS);
  });
});
