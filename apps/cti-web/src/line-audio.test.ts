import { describe, expect, it } from 'vitest';
import { createLineAudio, watchLineVolume } from './line-audio';

describe('createLineAudio', () => {
  it('quiet forever until the first loud sample, then counts from it', () => {
    let t = 1000;
    const a = createLineAudio(() => t);
    expect(a.quietForMs()).toBe(Infinity);
    a.push(0.001);
    expect(a.quietForMs()).toBe(Infinity); // below LOUD_LEVEL
    a.push(0.3);
    t = 1600;
    expect(a.quietForMs()).toBe(600);
  });

  it('subscribers get every sample; unsubscribe stops them', () => {
    const a = createLineAudio();
    const seen: number[] = [];
    const off = a.subscribe((l) => seen.push(l));
    a.push(0.1);
    off();
    a.push(0.2);
    expect(seen).toEqual([0.1]);
  });

  it("watchLineVolume feeds outputVolume (what the rep hears), not the rep's own mic", () => {
    const handlers: Record<string, (...a: number[]) => void> = {};
    const conn = { on: (e: string, cb: (...a: number[]) => void) => { handlers[e] = cb; } };
    const a = createLineAudio();
    const seen: number[] = [];
    a.subscribe((l) => seen.push(l));
    watchLineVolume(conn, a);
    handlers.volume!(0.9, 0.05);
    expect(seen).toEqual([0.05]);
  });

  it('watchLineVolume tolerates a connection without an event API', () => {
    expect(() => watchLineVolume({}, createLineAudio())).not.toThrow();
    expect(() => watchLineVolume(null, createLineAudio())).not.toThrow();
  });
});
