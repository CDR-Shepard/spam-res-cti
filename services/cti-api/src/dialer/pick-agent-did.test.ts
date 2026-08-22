import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/index.js';
import { pickRotationNumber } from '../rotation.js';
import { attemptIncrement, pickPoolDid, type Db } from './pick-did.js';
import { customerAttemptState, pickAgentDid, pickDidForRun, type AgentPickDeps } from './pick-agent-did.js';

// pickDidForRun is the live wiring: it hands the real rotation + the real
// atomic claim to pickAgentDid, or defers to the pool path. Those two
// collaborators are DB-bound, so they're mocked here and asserted on — the
// arguments they receive (above all the `'agent'` kind) are the behavior.
vi.mock('../rotation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../rotation.js')>()),
  pickRotationNumber: vi.fn(async () => null as string | null),
}));
vi.mock('./pick-did.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pick-did.js')>()),
  attemptIncrement: vi.fn(async () => true),
  pickPoolDid: vi.fn(async () => ({ e164: '+16195550777' }) as { e164: string } | null),
}));

function deps(over: Partial<AgentPickDeps> = {}): AgentPickDeps {
  return {
    attemptState: vi.fn(async () => ({ attemptsByNumber: new Map(), customerAttemptsTotal: 0, campaign: { maxAttempts: 5, perCustomerMaxAttempts: 15 } })),
    rotate: vi.fn(async () => '+16195550001'),
    claim: vi.fn(async () => true),
    ...over,
  };
}
const args = { orgId: 'O1', userId: 'U1', toE164: '+16195559999' };

describe('pickAgentDid', () => {
  it('skips the customer (does not pause the run) at the per-customer ceiling', async () => {
    const d = deps({ attemptState: vi.fn(async () => ({ attemptsByNumber: new Map(), customerAttemptsTotal: 15, campaign: { maxAttempts: 5, perCustomerMaxAttempts: 15 } })) });
    expect(await pickAgentDid(args, d)).toEqual({ skip: 'customer_ceiling' });
    expect(d.rotate).not.toHaveBeenCalled();
  });
  it('returns the rotation pick once its atomic claim succeeds, passing the per-customer caps through', async () => {
    const d = deps();
    expect(await pickAgentDid(args, d)).toEqual({ e164: '+16195550001' });
    expect(d.rotate).toHaveBeenCalledWith('+16195559999', { attemptsByNumber: expect.any(Map), maxAttemptsPerNumber: 5 }, undefined);
    expect(d.claim).toHaveBeenCalledWith('+16195550001');
  });
  it('retries rotation once excluding a number whose claim lost a race', async () => {
    const rotate = vi.fn().mockResolvedValueOnce('+16195550001').mockResolvedValueOnce('+16195550002');
    const claim = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const d = deps({ rotate, claim });
    expect(await pickAgentDid(args, d)).toEqual({ e164: '+16195550002' });
    // `?.` only for noUncheckedIndexedAccess — a missing 2nd rotation call
    // still fails the assertion (undefined !== the excluded Set).
    expect(rotate.mock.calls[1]?.[2]).toEqual(new Set(['+16195550001']));
  });
  it('fails closed when nothing is eligible', async () => {
    expect(await pickAgentDid(args, deps({ rotate: vi.fn(async () => null) }))).toBeNull();
    const claim = vi.fn(async () => false);
    expect(await pickAgentDid(args, deps({ claim }))).toBeNull();
  });
  it('with no campaign config there is no ceiling and no per-number cap', async () => {
    const d = deps({ attemptState: vi.fn(async () => ({ attemptsByNumber: new Map(), customerAttemptsTotal: 99, campaign: null })) });
    expect(await pickAgentDid(args, d)).toEqual({ e164: '+16195550001' });
    expect(d.rotate).toHaveBeenCalledWith('+16195559999', undefined, undefined);
  });
});

// ---------------------------------------------------------------------------
// customerAttemptState + pickDidForRun — the live wiring.
// ---------------------------------------------------------------------------

type GroupedRow = { from: string | null; n: number };

const CAMPAIGN = { attemptWindowDays: 14, maxAttempts: 5, perCustomerMaxAttempts: 15 };

/**
 * Minimal fake of the Drizzle surface the router touches: the campaign lookup,
 * the two grouped attempt counts (keyed by the table `.from()` is given), and
 * the agent claim's re-read of the rotation pick.
 */
function fakeDb(cfg: {
  campaign?: typeof CAMPAIGN | null;
  calls?: GroupedRow[];
  dialed?: GroupedRow[];
  agentRow?: { firstUsedAt: Date | null; warmupOverrideCap: number | null };
}): Db {
  return {
    query: {
      campaignConfigs: { findFirst: async () => (cfg.campaign === null ? undefined : cfg.campaign ?? CAMPAIGN) },
      outboundNumbers: { findFirst: async () => cfg.agentRow },
    },
    select: () => ({
      from: (table: unknown) => {
        const out = table === schema.calls ? cfg.calls ?? [] : cfg.dialed ?? [];
        const chain = {
          innerJoin: () => chain,
          where: () => chain,
          groupBy: async () => out,
        };
        return chain;
      },
    }),
  } as unknown as Db;
}

const poolArgs = { orgId: 'O1', userId: 'U1', toE164: '+16195559999', runKind: 'pool' } as const;
const agentArgs = { ...poolArgs, runKind: 'agent' } as const;

beforeEach(() => {
  vi.mocked(pickRotationNumber).mockReset().mockResolvedValue(null);
  vi.mocked(attemptIncrement).mockReset().mockResolvedValue(true);
  vi.mocked(pickPoolDid).mockReset().mockResolvedValue({ e164: '+16195550777' });
});

describe('customerAttemptState', () => {
  it('reports the campaign caps and the customer total across both dial paths', async () => {
    const db = fakeDb({ calls: [{ from: '+1A', n: 2 }], dialed: [{ from: '+1A', n: 3 }, { from: '+1B', n: 1 }] });
    const state = await customerAttemptState(db, 'O1', '+16195559999');
    expect(state.customerAttemptsTotal).toBe(6);
    expect(state.attemptsByNumber.get('+1A')).toBe(5);
    expect(state.campaign).toEqual({ maxAttempts: 5, perCustomerMaxAttempts: 15 });
  });

  it('with no campaign config: no caps and nothing counted', async () => {
    const state = await customerAttemptState(fakeDb({ campaign: null, dialed: [{ from: '+1A', n: 99 }] }), 'O1', '+1');
    expect(state).toEqual({ attemptsByNumber: new Map(), customerAttemptsTotal: 0, campaign: null });
  });
});

describe('pickDidForRun — pool runs', () => {
  it('skips the recipient at the shared ceiling WITHOUT touching the pool', async () => {
    const db = fakeDb({ calls: [{ from: '+1A', n: 15 }] });
    expect(await pickDidForRun(db, poolArgs)).toEqual({ skip: 'customer_ceiling' });
    expect(pickPoolDid).not.toHaveBeenCalled();
  });

  it('hits that ceiling on power-dial history alone — the dialer writes no `calls` row', async () => {
    const db = fakeDb({ calls: [], dialed: [{ from: '+1POOL', n: 15 }] });
    expect(await pickDidForRun(db, poolArgs)).toEqual({ skip: 'customer_ceiling' });
    expect(pickPoolDid).not.toHaveBeenCalled();
  });

  it('below the ceiling, defers to the unchanged pool path', async () => {
    const db = fakeDb({ calls: [{ from: '+1A', n: 14 }] });
    expect(await pickDidForRun(db, poolArgs)).toEqual({ e164: '+16195550777' });
    expect(pickPoolDid).toHaveBeenCalledWith(db, { orgId: 'O1', userId: 'U1', toE164: '+16195559999' });
  });

  it('passes a null pool pick straight through, so the run fails closed', async () => {
    vi.mocked(pickPoolDid).mockResolvedValue(null);
    expect(await pickDidForRun(fakeDb({}), poolArgs)).toBeNull();
  });
});

describe('pickDidForRun — agent runs', () => {
  it("claims the rotation pick as an 'agent' number, so a Task run can never burn a pool DID", async () => {
    vi.mocked(pickRotationNumber).mockResolvedValue('+16195550001');
    const db = fakeDb({ agentRow: { firstUsedAt: null, warmupOverrideCap: 40 } });
    expect(await pickDidForRun(db, agentArgs)).toEqual({ e164: '+16195550001' });
    expect(attemptIncrement).toHaveBeenCalledWith(db, 'O1', '+16195550001', 40, 'agent');
    expect(pickPoolDid).not.toHaveBeenCalled();
  });

  it('rotates with the per-number caps from both dial paths', async () => {
    vi.mocked(pickRotationNumber).mockResolvedValue('+16195550001');
    const db = fakeDb({
      calls: [{ from: '+16195550001', n: 1 }],
      dialed: [{ from: '+16195550001', n: 2 }],
      agentRow: { firstUsedAt: null, warmupOverrideCap: 40 },
    });
    await pickDidForRun(db, agentArgs);
    expect(pickRotationNumber).toHaveBeenCalledWith(
      db,
      'O1',
      'U1',
      '+16195559999',
      { attemptsByNumber: new Map([['+16195550001', 3]]), maxAttemptsPerNumber: 5 },
      undefined,
    );
  });

  it('refuses a rotation pick that is not one of this rep\'s own numbers (no row = no claim)', async () => {
    vi.mocked(pickRotationNumber).mockResolvedValue('+16195550001');
    expect(await pickDidForRun(fakeDb({ agentRow: undefined }), agentArgs)).toBeNull();
    expect(attemptIncrement).not.toHaveBeenCalled();
  });

  it('skips the recipient at the shared ceiling WITHOUT rotating', async () => {
    const db = fakeDb({ dialed: [{ from: '+1A', n: 15 }], agentRow: { firstUsedAt: null, warmupOverrideCap: 40 } });
    expect(await pickDidForRun(db, agentArgs)).toEqual({ skip: 'customer_ceiling' });
    expect(pickRotationNumber).not.toHaveBeenCalled();
  });
});
