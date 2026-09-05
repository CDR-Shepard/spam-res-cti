import { describe, expect, it, vi } from 'vitest';
import { shutdown } from './shutdown.js';

describe('shutdown', () => {
  it('stops the job runner, then closes the HTTP listener', async () => {
    const order: string[] = [];
    const runner = { stop: vi.fn(async () => { order.push('stop'); }) };
    const app = { close: vi.fn(async () => { order.push('close'); }) };
    await shutdown(runner, app);
    expect(order).toEqual(['stop', 'close']);
  });
  it('still closes the HTTP listener when the runner refuses to stop, and rethrows that error afterwards', async () => {
    const runner = { stop: vi.fn(async () => { throw new Error('pg-boss stop timed out'); }) };
    const app = { close: vi.fn(async () => {}) };
    await expect(shutdown(runner, app)).rejects.toThrow('pg-boss stop timed out');
    expect(app.close).toHaveBeenCalledTimes(1);
  });
});
