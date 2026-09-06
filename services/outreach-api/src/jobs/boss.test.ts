import { describe, expect, it, vi } from 'vitest';
import { JobRunner, type BossLike } from './boss.js';
import type { QueueDefinition } from './queues.js';

function fakeBoss(existing: string[] = []) {
  const calls: string[] = [];
  const handlers: Record<string, (e: Error) => void> = {};
  const boss: BossLike = {
    on: vi.fn((event: 'error', h: (e: Error) => void) => { handlers[event] = h; return boss; }),
    start: vi.fn(async () => { calls.push('start'); return boss; }),
    stop: vi.fn(async () => { calls.push('stop'); }),
    getQueue: vi.fn(async (name: string) => (existing.includes(name) ? { name } : null)),
    createQueue: vi.fn(async (name: string) => { calls.push(`create:${name}`); }),
  };
  return { boss, calls, handlers };
}
const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
const queues: QueueDefinition[] = [
  { name: 'a', options: { retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 900 } },
  { name: 'b', options: { retryLimit: 1, retryDelay: 5, retryBackoff: false, expireInSeconds: 60, deadLetter: 'b.dead' } },
];

describe('JobRunner', () => {
  it('starts the boss, creates only missing queues (dead-letter queues first), and becomes healthy', async () => {
    const { boss, calls } = fakeBoss(['a']);
    const runner = new JobRunner({ boss, queues, log });
    expect(runner.isHealthy()).toBe(false);
    await runner.start();
    expect(calls).toEqual(['start', 'create:b.dead', 'create:b']);
    expect(boss.createQueue).toHaveBeenCalledWith('b', queues[1]!.options);
    expect(runner.isHealthy()).toBe(true);
  });
  it('logs boss errors and marks itself unhealthy while stopped', async () => {
    const { boss, handlers } = fakeBoss();
    const runner = new JobRunner({ boss, queues: [], log });
    await runner.start();
    handlers['error']!(new Error('pool gone'));
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: 'pool gone' }), 'pg-boss error');
    await runner.stop();
    expect(boss.stop).toHaveBeenCalledWith({ graceful: true, timeout: 30_000 });
    expect(runner.isHealthy()).toBe(false);
  });
  it('stop is a no-op before start', async () => {
    const { boss } = fakeBoss();
    await new JobRunner({ boss, queues: [], log }).stop();
    expect(boss.stop).not.toHaveBeenCalled();
  });
});
