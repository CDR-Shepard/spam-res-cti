import { describe, expect, it } from 'vitest';
import { mayJoinNamedRun } from './join-guard.js';

const A = '7b0e5c1a-2f4d-4c3b-9a8e-1d2c3b4a5f60';
const B = '0d6f2e1b-3c5a-4e7d-8f90-a1b2c3d4e5f6';

describe('mayJoinNamedRun', () => {
  it("the rep's only live run joins — active (Start) or paused (Resume after a callback re-joins first)", () => {
    expect(mayJoinNamedRun(A, [{ id: A, status: 'active' }])).toBe(true);
    expect(mayJoinNamedRun(A, [{ id: A, status: 'paused' }])).toBe(true);
  });
  it("refuses a named run while ANOTHER run of the rep's is active: that run owns the rep-scoped room", () => {
    expect(mayJoinNamedRun(A, [{ id: A, status: 'paused' }, { id: B, status: 'active' }])).toBe(false);
  });
  it('refuses a run that is no longer live (stopped or done: not in the list)', () => {
    expect(mayJoinNamedRun(A, [{ id: B, status: 'active' }])).toBe(false);
    expect(mayJoinNamedRun(A, [])).toBe(false);
  });
  it('a paused run left by a dead tab does not lock out the active run — nor one paused run another', () => {
    expect(mayJoinNamedRun(A, [{ id: A, status: 'active' }, { id: B, status: 'paused' }])).toBe(true);
    expect(mayJoinNamedRun(A, [{ id: A, status: 'paused' }, { id: B, status: 'paused' }])).toBe(true);
  });
});
