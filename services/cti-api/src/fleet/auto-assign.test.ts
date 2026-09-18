import { describe, expect, it, vi } from 'vitest';
import {
  assignStarterNumbers,
  isEligibleProfile,
  parseProfiles,
  STARTER_NUMBERS,
  starterLabel,
  type AutoAssignDeps,
  type AutoAssignTx,
} from './auto-assign.js';
import { LA_CODES, SD_CODES, type Holding } from './plan.js';

const WHO = { orgId: 'org-1', userId: 'user-1', email: 'hudson@sjoinvestments.com' };

const la = (n: number, health = 'healthy', active = true): Holding[] =>
  Array.from({ length: n }, (_, i) => ({ e164: `+1213555${String(i).padStart(4, '0')}`, health, active }));
const sd = (n: number, health = 'healthy', active = true): Holding[] =>
  Array.from({ length: n }, (_, i) => ({ e164: `+1619555${String(i).padStart(4, '0')}`, health, active }));

/** A deps whose lock simply runs the callback, recording what it was locked for. */
function harness(held: Holding[], claim?: AutoAssignTx['claim']) {
  const tx: AutoAssignTx = {
    holdings: vi.fn(async () => held),
    claim: claim ?? vi.fn(async ({ n, codes }) =>
      Array.from({ length: n }, (_, i) => `+1${codes[0]}777${String(i).padStart(4, '0')}`)),
  };
  const lockedFor: Array<{ orgId: string; userId: string }> = [];
  const deps: AutoAssignDeps = {
    withUserLock: async (who, fn) => { lockedFor.push(who); return fn(tx); },
  };
  return { deps, tx, lockedFor };
}
const claimsOf = (tx: AutoAssignTx) => (tx.claim as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);

describe('assignStarterNumbers', () => {
  it('claims 6 LA then 6 SD for a rep who holds nothing', async () => {
    const h = harness([]);
    const out = await assignStarterNumbers(h.deps, WHO);

    expect(claimsOf(h.tx)).toEqual([
      { codes: LA_CODES, n: 6, label: 'Agent hudson LA' },
      { codes: SD_CODES, n: 6, label: 'Agent hudson SD' },
    ]);
    expect(out).toMatchObject({ status: 'assigned', shortLa: 0, shortSd: 0 });
  });

  it('the standard set is the same 6 / 6 the fleet policy uses', () => {
    expect(STARTER_NUMBERS).toEqual({ la: 6, sd: 6 });
  });

  it("locks on the rep's own org and user before reading anything", async () => {
    const h = harness([]);
    await assignStarterNumbers(h.deps, WHO);
    expect(h.lockedFor).toEqual([expect.objectContaining({ orgId: 'org-1', userId: 'user-1' })]);
  });

  // Nearly every sign-in. It must not touch the reserve at all.
  it('does nothing for a rep already at 6 / 6', async () => {
    const h = harness([...la(6), ...sd(6)]);
    expect(await assignStarterNumbers(h.deps, WHO)).toEqual({ status: 'already' });
    expect(h.tx.claim).not.toHaveBeenCalled();
  });

  it('does nothing for a rep above the standard', async () => {
    const h = harness([...la(9), ...sd(12)]);
    expect((await assignStarterNumbers(h.deps, WHO)).status).toBe('already');
  });

  // THE BUG THIS DESIGN EXISTS TO PREVENT. The reserve's LA and SD counts drift
  // apart, so a hire can get 6 LA and 0 SD. Gating on "holds nothing" would then
  // refuse every later retry and they would dial San Diego from a 213 forever.
  it('HEALS a partial set: a rep with 6 LA and no SD gets only the missing SD', async () => {
    const h = harness(la(6));
    const out = await assignStarterNumbers(h.deps, WHO);
    expect(claimsOf(h.tx)).toEqual([{ codes: SD_CODES, n: 6, label: 'Agent hudson SD' }]);
    expect(out).toMatchObject({ status: 'assigned', la: [], shortLa: 0, shortSd: 0 });
  });

  it('claims only the shortfall, never a fresh six on top', async () => {
    const h = harness([...la(4), ...sd(5)]);
    await assignStarterNumbers(h.deps, WHO);
    expect(claimsOf(h.tx)).toEqual([
      { codes: LA_CODES, n: 2, label: 'Agent hudson LA' },
      { codes: SD_CODES, n: 1, label: 'Agent hudson SD' },
    ]);
  });

  // One definition of "usable", shared with buy-rep / assign / plan. A rep whose
  // whole set was flagged is the most urgent case there is.
  it('does not count flagged or inactive numbers as held', async () => {
    const h = harness([...la(6, 'spam_likely'), ...sd(6, 'healthy', false)]);
    await assignStarterNumbers(h.deps, WHO);
    expect(claimsOf(h.tx).map((c) => c.n)).toEqual([6, 6]);
  });

  it('reports the shortfall honestly when the reserve runs dry', async () => {
    const claim = vi.fn()
      .mockResolvedValueOnce(['+12135550001', '+12135550002'])
      .mockResolvedValueOnce([]);
    const out = await assignStarterNumbers(harness([], claim).deps, WHO);
    expect(out).toEqual({
      status: 'assigned', la: ['+12135550001', '+12135550002'], sd: [], shortLa: 4, shortSd: 6,
    });
  });

  // Inside the Salesforce sign-in: never throw.
  it('never throws — a failed read is reported, not raised', async () => {
    const h = harness([]);
    (h.tx.holdings as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('pool exhausted'));
    expect(await assignStarterNumbers(h.deps, WHO)).toEqual({ status: 'failed', reason: 'pool exhausted' });
  });

  it('never throws — a failed claim is reported, not raised', async () => {
    const claim = vi.fn(async () => { throw new Error('deadlock detected'); });
    expect(await assignStarterNumbers(harness([], claim).deps, WHO)).toEqual({
      status: 'failed', reason: 'deadlock detected',
    });
  });

  // The throw has to ESCAPE the lock callback so the live transaction rolls the
  // LA claim back. Swallowing it inside would commit half a set.
  it('lets a failing SD claim escape the transaction so the LA claim rolls back', async () => {
    const claim = vi.fn()
      .mockResolvedValueOnce(['+12135550001'])
      .mockRejectedValueOnce(new Error('connection reset'));
    let escaped: unknown;
    const tx: AutoAssignTx = { holdings: async () => [], claim };
    const deps: AutoAssignDeps = {
      withUserLock: async (_who, fn) => {
        try { return await fn(tx); } catch (e) { escaped = e; throw e; }
      },
    };
    const out = await assignStarterNumbers(deps, WHO);
    expect((escaped as Error).message).toBe('connection reset');
    expect(out).toEqual({ status: 'failed', reason: 'connection reset' });
  });

  it('never throws — a failure to take the lock is reported, not raised', async () => {
    const deps: AutoAssignDeps = { withUserLock: async () => { throw new Error('too many connections'); } };
    expect(await assignStarterNumbers(deps, WHO)).toEqual({ status: 'failed', reason: 'too many connections' });
  });
});

describe('starterLabel', () => {
  // `buy-rep` counts a rep's earlier purchases by this exact label.
  it('is byte-identical to what the manual assign command writes', () => {
    expect(starterLabel('hudson@sjoinvestments.com', 'LA')).toBe('Agent hudson LA');
    expect(starterLabel('s.oots@sjoinvestments.com', 'SD')).toBe('Agent s.oots SD');
  });
});

describe('isEligibleProfile', () => {
  it('allows a rep on a listed profile, case- and space-insensitively', () => {
    expect(isEligibleProfile('Sales', ['Sales'])).toBe(true);
    expect(isEligibleProfile('  sales ', ['Sales'])).toBe(true);
    expect(isEligibleProfile('Wholesale', ['Sales', 'Wholesale'])).toBe(true);
  });

  // Anyone in the Salesforce org can open the app once. They must not each walk
  // off with 12 billable numbers.
  it('refuses everyone else', () => {
    expect(isEligibleProfile('Accounting', ['Sales'])).toBe(false);
    expect(isEligibleProfile('Escrow & Listing Manager', ['Sales'])).toBe(false);
  });

  // Failing closed costs one retry on the next sign-in; failing open costs numbers.
  it('refuses an unknown profile rather than guessing', () => {
    expect(isEligibleProfile(null, ['Sales'])).toBe(false);
    expect(isEligibleProfile(undefined, ['Sales'])).toBe(false);
    expect(isEligibleProfile('', ['Sales'])).toBe(false);
  });

  it('refuses everyone when no profile is configured', () => {
    expect(isEligibleProfile('Sales', [])).toBe(false);
  });
});

describe('parseProfiles', () => {
  it('splits, trims and drops blanks', () => {
    expect(parseProfiles('Sales, Wholesale ,,')).toEqual(['Sales', 'Wholesale']);
    expect(parseProfiles(undefined)).toEqual([]);
    expect(parseProfiles('')).toEqual([]);
  });
});
