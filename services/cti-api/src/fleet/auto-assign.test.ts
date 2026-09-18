import { describe, expect, it, vi } from 'vitest';
import { assignStarterNumbers, STARTER_NUMBERS, starterLabel, type AutoAssignDeps } from './auto-assign.js';
import { LA_CODES, SD_CODES } from './plan.js';

const WHO = { orgId: 'org-1', userId: 'user-1', email: 'Hudson@sjoinvestments.com' };

function deps(over: Partial<AutoAssignDeps> = {}): AutoAssignDeps {
  return {
    countHeld: vi.fn(async () => 0),
    claim: vi.fn(async ({ n, codes }) =>
      Array.from({ length: n }, (_, i) => `+1${codes[0]}555${String(i).padStart(4, '0')}`)),
    ...over,
  };
}

describe('assignStarterNumbers', () => {
  it('claims 6 LA then 6 SD for a rep who holds nothing', async () => {
    const d = deps();
    const out = await assignStarterNumbers(d, WHO);

    expect(out.status).toBe('assigned');
    const calls = (d.claim as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ codes: LA_CODES, n: 6, orgId: 'org-1', userId: 'user-1' });
    expect(calls[1]).toMatchObject({ codes: SD_CODES, n: 6, orgId: 'org-1', userId: 'user-1' });
    if (out.status === 'assigned') {
      expect(out.la).toHaveLength(6);
      expect(out.sd).toHaveLength(6);
      expect(out.shortLa).toBe(0);
      expect(out.shortSd).toBe(0);
    }
  });

  it('the starter set is the same 6 / 6 the fleet policy uses', () => {
    expect(STARTER_NUMBERS).toEqual({ la: 6, sd: 6 });
  });

  // Every sign-in after the first lands here. It must not touch the reserve.
  it('does nothing for a rep who already holds numbers', async () => {
    const d = deps({ countHeld: vi.fn(async () => 12) });
    expect(await assignStarterNumbers(d, WHO)).toEqual({ status: 'already', held: 12 });
    expect(d.claim).not.toHaveBeenCalled();
  });

  // One number is enough to mean "a person already decided this rep's set".
  // Topping up on every sign-in would fight an operator who removed numbers on
  // purpose, and let ordinary logins drain the reserve.
  it('does NOT top up a rep who holds even one number', async () => {
    const d = deps({ countHeld: vi.fn(async () => 1) });
    expect((await assignStarterNumbers(d, WHO)).status).toBe('already');
    expect(d.claim).not.toHaveBeenCalled();
  });

  it('reports the shortfall honestly when the reserve runs dry', async () => {
    const claim = vi
      .fn()
      .mockResolvedValueOnce(['+12135550001', '+12135550002']) // only 2 LA left
      .mockResolvedValueOnce([]); // no SD at all
    const out = await assignStarterNumbers(deps({ claim }), WHO);
    expect(out).toEqual({
      status: 'assigned',
      la: ['+12135550001', '+12135550002'],
      sd: [],
      shortLa: 4,
      shortSd: 6,
    });
  });

  // It runs inside the Salesforce sign-in. A rep with no numbers is a one-minute
  // operator fix; a rep who cannot sign in cannot work.
  it('never throws — a failed count is reported, not raised', async () => {
    const d = deps({ countHeld: vi.fn(async () => { throw new Error('pool exhausted'); }) });
    expect(await assignStarterNumbers(d, WHO)).toEqual({ status: 'failed', reason: 'pool exhausted' });
  });

  it('never throws — a failed claim is reported, not raised', async () => {
    const d = deps({ claim: vi.fn(async () => { throw new Error('deadlock detected'); }) });
    expect(await assignStarterNumbers(d, WHO)).toEqual({ status: 'failed', reason: 'deadlock detected' });
  });
});

describe('starterLabel', () => {
  // `buy-rep` counts a rep's earlier purchases by this exact label. A different
  // spelling would make it re-buy numbers the rep already holds.
  it('is byte-identical to what the manual assign command writes', () => {
    expect(starterLabel('hudson@sjoinvestments.com', 'LA')).toBe('Agent hudson LA');
    expect(starterLabel('s.oots@sjoinvestments.com', 'SD')).toBe('Agent s.oots SD');
  });

  it('labels the two claims LA and SD respectively', async () => {
    const d = deps();
    await assignStarterNumbers(d, { ...WHO, email: 'joseph@sjoinvestments.com' });
    const labels = (d.claim as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].label);
    expect(labels).toEqual(['Agent joseph LA', 'Agent joseph SD']);
  });
});
