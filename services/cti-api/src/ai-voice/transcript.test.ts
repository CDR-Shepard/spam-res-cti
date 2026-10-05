import { describe, expect, it, vi } from 'vitest';
import { TranscriptBuffer, TRANSCRIPT_LINE_MAX } from './transcript.js';
import type { TranscriptEntry } from './store.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const AT = new Date('2026-10-05T18:00:00Z');

function harness() {
  const writes: Array<readonly TranscriptEntry[]> = [];
  const timers: Array<{ cb: () => void; ms: number; cleared: boolean }> = [];
  const write = vi.fn(async (e: readonly TranscriptEntry[]) => {
    writes.push(e);
  });
  const buf = new TranscriptBuffer(write, {
    log,
    setTimer: (cb, ms) => {
      const t = { cb, ms, cleared: false };
      timers.push(t);
      return t as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (h) => {
      (h as unknown as { cleared: boolean }).cleared = true;
    },
  });
  return { buf, writes, timers, write };
}

describe('TranscriptBuffer', () => {
  it('batches lines into one write per interval', async () => {
    const h = harness();
    h.buf.push({ role: 'agent', text: 'Hi', at: AT });
    h.buf.push({ role: 'caller', text: 'Hello', at: AT });
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(1000);
    expect(h.writes).toHaveLength(0);
    h.timers[0]!.cb();
    await h.buf.flush();
    expect(h.writes).toEqual([
      [
        { role: 'agent', text: 'Hi', at: AT.toISOString() },
        { role: 'caller', text: 'Hello', at: AT.toISOString() },
      ],
    ]);
  });

  it('close flushes immediately, cancels the timer, and later lines write straight away', async () => {
    const h = harness();
    h.buf.push({ role: 'agent', text: 'Bye', at: AT });
    await h.buf.close();
    expect(h.timers[0]!.cleared).toBe(true);
    expect(h.writes).toHaveLength(1);
    h.buf.push({ role: 'system', text: 'late', at: AT });
    await h.buf.flush();
    expect(h.writes).toHaveLength(2);
    expect(h.timers).toHaveLength(1);
  });

  it('caps a runaway line and logs (never throws) a failed write', async () => {
    const h = harness();
    h.write.mockRejectedValueOnce(new Error('db down'));
    h.buf.push({ role: 'caller', text: 'x'.repeat(TRANSCRIPT_LINE_MAX + 50), at: AT });
    await expect(h.buf.close()).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith({ lines: 1, err: 'db down' }, 'ai-voice: transcript write failed');
    expect(h.write.mock.calls[0]![0][0]!.text).toHaveLength(TRANSCRIPT_LINE_MAX);
  });

  it('an empty flush writes nothing', async () => {
    const h = harness();
    await h.buf.flush();
    expect(h.write).not.toHaveBeenCalled();
  });
});
