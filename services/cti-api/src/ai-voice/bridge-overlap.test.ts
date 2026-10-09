import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_WORDS_INTERRUPT_MS, OverlapGate } from './bridge-overlap.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function gate() {
  const onInterrupt = vi.fn();
  const g = new OverlapGate({ setTimer: (cb, ms) => setTimeout(cb, ms), clearTimer: (h) => clearTimeout(h), onInterrupt });
  return { g, onInterrupt };
}

describe('OverlapGate', () => {
  it('keeps quiet through listening sounds and ignores them at the end', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onDelta('c1', ' Mm');
    g.onDelta('c1', '-hmm');
    vi.advanceTimersByTime(NO_WORDS_INTERRUPT_MS * 2);
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(g.finish('c1', 'Mm-hmm.')).toBe('ignore');
    expect(g.itemId).toBeNull();
  });

  it('interrupts on a stop word as soon as it streams in, and closes', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onDelta('c1', ' Wait');
    expect(onInterrupt).toHaveBeenCalledWith('words', 'c1');
    expect(g.itemId).toBeNull();
    g.onDelta('c1', ' hold on');
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('interrupts on the second real word', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onDelta('c1', " I'm");
    expect(onInterrupt).not.toHaveBeenCalled();
    g.onDelta('c1', ' interested');
    expect(onInterrupt).toHaveBeenCalledWith('words', 'c1');
  });

  it('interrupts after 3 s of talk with no word at all', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    vi.advanceTimersByTime(NO_WORDS_INTERRUPT_MS - 1);
    expect(onInterrupt).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onInterrupt).toHaveBeenCalledWith('no words', 'c1');
    expect(g.itemId).toBeNull();
  });

  it('passes the interrupted item id', () => {
    const { g, onInterrupt } = gate();
    g.open('c7', { cuttable: true, late: false });
    g.onDelta('c7', ' Wait');
    expect(onInterrupt).toHaveBeenCalledWith('words', 'c7');
  });

  it('a wordless sound that stops before the timer is settled by the final text, not cut', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    vi.advanceTimersByTime(800);
    g.onSpeechStopped('c1');
    vi.advanceTimersByTime(NO_WORDS_INTERRUPT_MS * 2);
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(g.finish('c1', '')).toBe('ignore');
  });

  it('onSpeechStopped for another item leaves the timer armed', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onSpeechStopped('c2');
    vi.advanceTimersByTime(NO_WORDS_INTERRUPT_MS);
    expect(onInterrupt).toHaveBeenCalledWith('no words', 'c1');
  });

  it('an uncuttable overlap never arms the no-words timer', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: false, late: false });
    vi.advanceTimersByTime(NO_WORDS_INTERRUPT_MS * 3);
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(g.itemId).toBe('c1');
  });

  it('a blank final transcript falls back to the streamed words', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onDelta('c1', " I'm");
    expect(g.finish('c1', '')).toBe('ignore');
    g.open('c2', { cuttable: true, late: true });
    g.onDelta('c2', ' Yeah');
    expect(g.finish('c2', '   ')).toBe('answer');
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it('ignores deltas for other items', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onDelta('c2', ' Wait');
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(g.itemId).toBe('c1');
  });

  it('a late listening sound is an answer', () => {
    const { g } = gate();
    g.open('c1', { cuttable: true, late: true });
    g.onDelta('c1', ' Yeah sure');
    expect(g.finish('c1', 'Yeah, sure.')).toBe('answer');
  });

  it('a wordless late overlap (a cough near the end) is ignored, not answered', () => {
    const { g } = gate();
    g.open('c1', { cuttable: true, late: true });
    g.onSpeechStopped('c1');
    expect(g.finish('c1', '')).toBe('ignore');
    g.open('c2', { cuttable: false, late: true });
    expect(g.finish('c2', '  ')).toBe('ignore');
  });

  it('settles on the final text when the words arrived late', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    expect(g.finish('c1', 'Who is this?')).toBe('interrupted');
    expect(onInterrupt).toHaveBeenCalledWith('words', 'c1');
  });

  it('never cuts an uncuttable overlap (the opener) — a real interruption becomes an answer', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: false, late: false });
    g.onDelta('c1', ' Wait who is this');
    vi.advanceTimersByTime(NO_WORDS_INTERRUPT_MS * 2);
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(g.finish('c1', 'Wait, who is this?')).toBe('answer');
  });

  it('an uncuttable listening sound that is not late is ignored', () => {
    const { g } = gate();
    g.open('c1', { cuttable: false, late: false });
    expect(g.finish('c1', 'Hello?')).toBe('ignore');
  });

  it('opening a new overlap or close() cancels the no-words timer', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.open('c2', { cuttable: true, late: false });
    g.close();
    vi.advanceTimersByTime(NO_WORDS_INTERRUPT_MS * 2);
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(g.finish('c2', 'Wait')).toBe('ignore');
  });

  it('an overlap pushed aside by new speech is still judged by its words, and a cut settles both', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.onSpeechStopped('c1');
    g.open('c2', { cuttable: true, late: false });
    expect(g.has('c1')).toBe(true);
    expect(g.has('c2')).toBe(true);
    g.onDelta('c1', ' Wait');
    expect(onInterrupt).toHaveBeenCalledWith('words', 'c1');
    expect(g.has('c1')).toBe(false);
    expect(g.itemId).toBeNull();
  });

  it('a pushed-aside overlap settles on its final text and leaves the current one alone', () => {
    const { g, onInterrupt } = gate();
    g.open('c1', { cuttable: true, late: true });
    g.open('c2', { cuttable: true, late: false });
    expect(g.finish('c1', 'Yeah, sure.')).toBe('answer');
    expect(g.has('c1')).toBe(false);
    expect(g.itemId).toBe('c2');
    g.open('c3', { cuttable: false, late: false });
    expect(g.finish('c2', 'Who is this?')).toBe('interrupted');
    expect(onInterrupt).toHaveBeenCalledWith('words', 'c2');
    expect(g.has('c3')).toBe(false);
  });

  it('close() forgets pushed-aside overlaps too', () => {
    const { g } = gate();
    g.open('c1', { cuttable: true, late: false });
    g.open('c2', { cuttable: true, late: false });
    g.close();
    expect(g.has('c1')).toBe(false);
    expect(g.finish('c1', 'Wait')).toBe('ignore');
  });
});
