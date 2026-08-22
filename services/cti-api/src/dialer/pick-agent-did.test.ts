import { describe, expect, it, vi } from 'vitest';
import { pickAgentDid, type AgentPickDeps } from './pick-agent-did.js';

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
