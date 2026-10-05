import { describe, expect, it } from 'vitest';
import { QUEUES } from './queues.js';
import { SCHEDULES } from './schedules.js';

describe('tick queues and schedules', () => {
  it('declares the phase 1A tick queues as stately, never retried, 15-minute expiry', () => {
    const byName = new Map(QUEUES.map((q) => [q.name, q.options]));
    for (const name of ['campaign.refresh', 'record.triage', 'touch.plan']) {
      expect(byName.get(name)).toEqual({ retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 900, policy: 'stately' });
    }
  });
  it('schedules refresh every 5 minutes and triage and planning every minute', () => {
    expect(SCHEDULES).toEqual([
      { queue: 'campaign.refresh', cron: '*/5 * * * *' },
      { queue: 'record.triage', cron: '* * * * *' },
      { queue: 'touch.plan', cron: '* * * * *' },
    ]);
  });
  it('schedules only queues that exist', () => {
    const names = new Set(QUEUES.map((q) => q.name));
    for (const s of SCHEDULES) expect(names.has(s.queue)).toBe(true);
  });
});
