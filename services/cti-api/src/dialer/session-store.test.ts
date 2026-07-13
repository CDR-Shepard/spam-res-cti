import { describe, expect, it } from 'vitest';
import { sessionCounts } from './session-store.js';

const item = (status: string) => ({ status } as Parameters<typeof sessionCounts>[0][number]);

describe('sessionCounts', () => {
  it('tallies queue item statuses', () => {
    const c = sessionCounts([
      item('done'), item('connected'), item('no_connect'), item('no_connect'),
      item('skipped'), item('unreachable'), item('pending'), item('dialing'),
    ]);
    expect(c).toMatchObject({ total: 8, done: 1, connected: 1, noConnect: 2, skipped: 1, unreachable: 1, pending: 1 });
  });
});
