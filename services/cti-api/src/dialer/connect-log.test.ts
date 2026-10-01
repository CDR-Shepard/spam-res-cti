import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import {
  insertConnect,
  orgIsTwoParty,
  recordBridgedCall,
  stampConnectEnded,
  storeConnectRecording,
  type BridgedCall,
  type ConnectLogDeps,
} from './connect-log.js';

const NOW = new Date('2026-10-01T18:00:00Z');
const SID = 'CA' + 'a'.repeat(32);
const CALL: BridgedCall = {
  orgId: 'org-1', userId: 'rep-1', sfUserId: '005REP000000001', sessionId: 'sess-1', itemId: 'item-1',
  callSid: SID, objectType: 'Opportunity', recordId: '006000000000001AAA',
  fromNumber: '+16195550101', toNumber: '+16195559999',
};

function harness(over: Partial<ConnectLogDeps> = {}, inserted: Array<{ id: string }> = [{ id: 'conn-1' }]) {
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const order: string[] = [];
  const db = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserts.push(v);
        return { onConflictDoNothing: () => ({ returning: async () => { order.push('insert'); return inserted; } }) };
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => { updates.push(patch); order.push(`state:${String(patch.recordingState)}`); },
      }),
    }),
  } as unknown as ConnectLogDeps['db'];
  const deps: ConnectLogDeps = {
    db,
    now: () => NOW,
    recordingEnabled: true,
    isTwoParty: vi.fn(async () => false),
    startRecording: vi.fn(async () => { order.push('start'); }),
    ...over,
  };
  return { deps, inserts, updates, order };
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('recordBridgedCall', () => {
  it('writes the row, THEN starts the recording keyed by the new row id, THEN stamps requested', async () => {
    const h = harness();
    await recordBridgedCall(CALL, h.deps);
    expect(h.order).toEqual(['insert', 'start', 'state:requested']);
    expect(h.deps.startRecording).toHaveBeenCalledWith(SID, 'conn-1');
    expect(h.inserts[0]).toMatchObject({
      orgId: 'org-1', userId: 'rep-1', sfUserId: '005REP000000001', sessionId: 'sess-1', itemId: 'item-1',
      callSid: SID, objectType: 'Opportunity', recordId: '006000000000001AAA',
      fromNumber: '+16195550101', toNumber: '+16195559999', bridgedAt: NOW,
    });
  });

  it('a re-delivered AMD "human" (the insert conflicts) records nothing a second time', async () => {
    const h = harness({}, []);
    await recordBridgedCall(CALL, h.deps);
    expect(h.deps.startRecording).not.toHaveBeenCalled();
    expect(h.updates).toEqual([]);
  });

  it('a row with no dialed number or DID writes nothing and says so', async () => {
    const h = harness();
    await recordBridgedCall({ ...CALL, toNumber: null }, h.deps);
    expect(h.inserts).toEqual([]);
    expect(warn).toHaveBeenCalledWith('[dialer] bridged call not logged: no number', { itemId: 'item-1' });
  });

  it('a switch off → skipped_switch, no recording, but the row (and so the Task) stays', async () => {
    const h = harness({ recordingEnabled: false });
    await recordBridgedCall(CALL, h.deps);
    expect(h.inserts).toHaveLength(1);
    expect(h.deps.startRecording).not.toHaveBeenCalled();
    expect(h.updates).toEqual([expect.objectContaining({ recordingState: 'skipped_switch' })]);
  });

  it('a two-party org → skipped_consent: this path has no automated disclosure', async () => {
    const h = harness({ isTwoParty: vi.fn(async () => true) });
    await recordBridgedCall(CALL, h.deps);
    expect(h.deps.isTwoParty).toHaveBeenCalledWith('org-1');
    expect(h.deps.startRecording).not.toHaveBeenCalled();
    expect(h.updates).toEqual([expect.objectContaining({ recordingState: 'skipped_consent' })]);
  });

  it('a failed consent lookup fails CLOSED — skipped_consent, logged', async () => {
    const h = harness({ isTwoParty: vi.fn(async () => { throw new Error('db down'); }) });
    await recordBridgedCall(CALL, h.deps);
    expect(h.deps.startRecording).not.toHaveBeenCalled();
    expect(h.updates).toEqual([expect.objectContaining({ recordingState: 'skipped_consent' })]);
    expect(error).toHaveBeenCalledWith('[dialer] consent lookup failed — not recording', { connectId: 'conn-1', err: 'db down' });
  });

  it('a recording that will not start → start_failed, logged, and NO throw (the rep is on the call)', async () => {
    const h = harness({ startRecording: vi.fn(async () => { throw new Error('21220'); }) });
    await expect(recordBridgedCall(CALL, h.deps)).resolves.toBeUndefined();
    expect(h.updates).toEqual([expect.objectContaining({ recordingState: 'start_failed' })]);
    expect(error).toHaveBeenCalledWith('[dialer] recording did not start', { connectId: 'conn-1', err: '21220' });
  });
});

describe('orgIsTwoParty', () => {
  it('reads the org\'s default campaign', async () => {
    const findFirst = vi.fn(async () => ({ recordingConsentMode: 'two_party' }));
    const db = { query: { campaignConfigs: { findFirst } } } as unknown as ConnectLogDeps['db'];
    expect(await orgIsTwoParty(db, 'org-1')).toBe(true);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
  it('no campaign row, or any other mode, is not two-party', async () => {
    for (const row of [undefined, { recordingConsentMode: 'off' }, { recordingConsentMode: 'one_party' }]) {
      const db = { query: { campaignConfigs: { findFirst: vi.fn(async () => row) } } } as unknown as ConnectLogDeps['db'];
      expect(await orgIsTwoParty(db, 'org-1')).toBe(false);
    }
  });
});

describe('the connect-log SQL, rendered', () => {
  const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });

  it('insertConnect uses the BARE on conflict do nothing (a target would 42P10 on a partial index; ours is full, keep it bare)', () => {
    const { sql } = insertConnect(db, { ...CALL, fromNumber: '+16195550101', toNumber: '+16195559999' }, NOW).toSQL();
    expect(sql).toContain('on conflict do nothing');
    expect(sql).not.toContain('on conflict ("call_sid")');
    expect(sql).toContain('returning "id"');
  });

  it('stampConnectEnded only stamps a row still open, by call sid, and measures talk time from the bridge', () => {
    const { sql, params } = stampConnectEnded(db, SID, NOW).toSQL();
    expect(sql).toContain('"ended_at" = $');
    expect(sql).toContain('"talk_seconds" = greatest(0, round(extract(epoch from ($');
    expect(sql).toContain('"dialer_connects"."bridged_at"');
    expect(sql).toMatch(/where \("dialer_connects"\."call_sid" = \$\d+ and "dialer_connects"\."ended_at" is null\)/);
    expect(params).toContain(SID);
  });

  it('storeConnectRecording matches BOTH the row id and the call sid, and only hurries a row that already has its Task', () => {
    const { sql, params } = storeConnectRecording(db, 'conn-1', SID, 'https://api.twilio.com/x.mp3', NOW).toSQL();
    expect(sql).toMatch(/where \("dialer_connects"\."id" = \$\d+ and "dialer_connects"\."call_sid" = \$\d+\)/);
    expect(sql).toContain(`case when "dialer_connects"."task_state" = 'created' then`);
    expect(params).toEqual(expect.arrayContaining(['conn-1', SID, 'https://api.twilio.com/x.mp3']));
  });
});
