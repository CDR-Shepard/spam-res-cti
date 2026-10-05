import { describe, expect, it, vi } from 'vitest';
import { OUTBOX_MAX, Outbox } from './bridge-outbox.js';

describe('Outbox', () => {
  it('drains in order, with prepended items first', () => {
    const box = new Outbox(() => {});
    box.push('a', true);
    box.push('b', false);
    box.prepend('first');
    expect(box.drain()).toEqual(['first', 'a', 'b']);
    expect(box.drain()).toEqual([]);
  });

  it('caps at OUTBOX_MAX by dropping the oldest droppable frames, warning once', () => {
    const overflow = vi.fn();
    const box = new Outbox(overflow);
    box.push('keep-1', false);
    for (let i = 0; i < OUTBOX_MAX + 100; i++) box.push(`audio-${i}`, true);
    box.push('keep-2', false);
    const out = box.drain();
    expect(out).toHaveLength(OUTBOX_MAX);
    expect(out[0]).toBe('keep-1');
    expect(out[out.length - 1]).toBe('keep-2');
    expect(out).not.toContain('audio-0');
    expect(out).toContain(`audio-${OUTBOX_MAX + 99}`);
    expect(overflow).toHaveBeenCalledTimes(1);
  });

  it('never drops non-droppable items, even past the cap', () => {
    const box = new Outbox(() => {}, 3);
    box.push('x', false);
    box.push('y', false);
    box.push('z', false);
    box.push('w', false);
    expect(box.drain()).toEqual(['x', 'y', 'z', 'w']);
  });

  it('clear empties the queue', () => {
    const box = new Outbox(() => {});
    box.push('a', true);
    box.clear();
    expect(box.drain()).toEqual([]);
  });
});
