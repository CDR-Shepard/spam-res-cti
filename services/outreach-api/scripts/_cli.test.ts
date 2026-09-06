import { afterEach, describe, expect, it, vi } from 'vitest';
import { emit, fail } from './_cli.js';

type WriteCb = (err?: Error | null) => void;
afterEach(() => vi.restoreAllMocks());

describe('cli output', () => {
  it('emit resolves only once stdout has confirmed the write (a pipe cannot truncate it)', async () => {
    let flushed = false;
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((_chunk: unknown, cb?: unknown) => {
      setTimeout(() => { flushed = true; (cb as WriteCb)(); }, 5);
      return true;
    }) as typeof process.stdout.write);
    const pending = emit('{"tenantId":"t1"}');
    expect(flushed).toBe(false);
    await pending;
    expect(flushed).toBe(true);
    expect(write).toHaveBeenCalledWith('{"tenantId":"t1"}\n', expect.any(Function));
  });
  it('fail writes the message to stderr, waits for the flush, then exits 1', async () => {
    const order: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown, cb?: unknown) => {
      order.push(`write:${String(chunk).trim()}`);
      setTimeout(() => (cb as WriteCb)(), 5);
      return true;
    }) as typeof process.stderr.write);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      order.push(`exit:${code}`);
      throw new Error('exit called');
    }) as typeof process.exit);
    await expect(fail('no such tenant')).rejects.toThrow('exit called');
    expect(order).toEqual(['write:no such tenant', 'exit:1']);
  });
});
