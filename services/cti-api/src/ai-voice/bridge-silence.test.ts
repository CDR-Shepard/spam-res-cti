import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_CHECK_MS, MAX_SILENCE_CHECKS, SILENCE_CHECK_MS, SilenceCheck, silenceNoteItem } from './bridge-silence.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function check() {
  const onSilence = vi.fn();
  const c = new SilenceCheck({ setTimer: (cb, ms) => setTimeout(cb, ms), clearTimer: (h) => clearTimeout(h), onSilence });
  return { c, onSilence };
}

describe('SilenceCheck', () => {
  it('fires once per arm with the seconds waited', () => {
    const { c, onSilence } = check();
    c.arm(SILENCE_CHECK_MS);
    vi.advanceTimersByTime(SILENCE_CHECK_MS - 1);
    expect(onSilence).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSilence).toHaveBeenCalledWith(8);
    vi.advanceTimersByTime(SILENCE_CHECK_MS * 3);
    expect(onSilence).toHaveBeenCalledTimes(1);
  });

  it(`stops after ${MAX_SILENCE_CHECKS} check-ins until the caller is heard`, () => {
    const { c, onSilence } = check();
    for (let i = 0; i < MAX_SILENCE_CHECKS + 1; i += 1) {
      c.arm(SILENCE_CHECK_MS);
      vi.advanceTimersByTime(SILENCE_CHECK_MS);
    }
    expect(onSilence).toHaveBeenCalledTimes(MAX_SILENCE_CHECKS);
    c.heard();
    c.arm(HOLD_CHECK_MS);
    vi.advanceTimersByTime(HOLD_CHECK_MS);
    expect(onSilence).toHaveBeenLastCalledWith(30);
    expect(onSilence).toHaveBeenCalledTimes(MAX_SILENCE_CHECKS + 1);
  });

  it('cancel() and re-arming replace the pending timer', () => {
    const { c, onSilence } = check();
    c.arm(SILENCE_CHECK_MS);
    c.arm(HOLD_CHECK_MS);
    vi.advanceTimersByTime(SILENCE_CHECK_MS);
    expect(onSilence).not.toHaveBeenCalled();
    c.cancel();
    vi.advanceTimersByTime(HOLD_CHECK_MS);
    expect(onSilence).not.toHaveBeenCalled();
  });
});

describe('silenceNoteItem', () => {
  it('is a hidden user note the agent reads, not caller speech', () => {
    expect(silenceNoteItem(8)).toEqual({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '(No one has said anything for 8 seconds.)' }] },
    });
  });
});
